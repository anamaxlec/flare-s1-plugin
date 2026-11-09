const HOST = "stage1st.com";
const ORIGIN = "https://" + HOST;
const BASE = ORIGIN + "/2b/";
const LOGIN = "member.php?mod=logging&action=login";
const API = "api/mobile/index.php?module=";
const CAPS = {
  "flare.datasource.timeline/v1": ["page"],
  "flare.datasource.tab-catalog/v1": ["page"],
  "flare.datasource.post/v1": ["detail", "context"],
  "flare.datasource.profile/v1": ["byId", "byHandle"],
};
const LANGUAGE = ["zh-CN"];
type Row = Record<string, unknown>;
type Cookie = { name: string; value: string };

defineFlareSocialPlugin({
  detector: {
    detect({ origin }) {
      return origin === ORIGIN
        ? { match: "exact", canonicalOrigin: ORIGIN, software: "Discuz!", instance: { domain: HOST, title: "Stage1st" } }
        : { match: "none", canonicalOrigin: origin };
    },
  },
  login: {
    browser: {
      begin() { return { type: "webCookie", startUrl: BASE + LOGIN }; },
      async check(request) {
        const cookies = request.cookies.cookies
          .filter(({ sourceUrl }) => sourceUrl === BASE + API + "login&version=4")
          .map(({ name, value }) => ({ name, value }));
        if (!cookies.some(({ name, value }) => name.endsWith("_auth") && value)) return { type: "pending" };
        const data = await api("login", {}, cookies);
        const accountId = id(data.member_uid);
        const profile = accountId ? user(accountId, str(data.member_username), str(data.member_avatar)) : undefined;
        return profile && accountId
          ? { type: "success", value: { accountId, origin: ORIGIN, profile, credential: { cookies }, capabilities: CAPS } }
          : { type: "pending" };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        const fid = id(request.parameters.fid ?? request.page.parameters.fid);
        if (!fid) fail("Validation", "没有指定版面");
        const position = cursor(request.page);
        const filter = request.parameters.digest === "1" ? { filter: "digest", digest: "1" } : undefined;
        const data = await api("forumdisplay", { fid, page: String(position.batch), tpp: "15", ...filter }, await cookiesFor(context));
        const forum = obj(data.forum);
        if (!Array.isArray(data.forum_threadlist)) fail("InvalidResponse", "S1 没有返回版面帖子");
        const items = data.forum_threadlist.flatMap((entry) => {
          const thread = obj(entry);
          const tid = id(thread?.tid);
          if (!thread || !tid) return [];
          // Discuz repeats pinned topics at the start of remote pages.
          if (position.batch > 1 && Number(thread.displayorder) > 0) return [];
          return [{ type: "post" as const, post: preview(thread, tid, fid, str(forum?.name)) }];
        });
        const count = number(forum?.threadcount ?? forum?.threads);
        const size = number(data.tpp) ?? 15;
        return slice(items, request.page, position,
          data.forum_threadlist.length > 0 && (count === undefined ? data.forum_threadlist.length >= size : position.batch * size < count));
      },
    },
    tabCatalog: {
      async page(_request, context) {
        const data = await api("forumindex", {}, await cookiesFor(context));
        const forums = new Map(list(data.forumlist).map((entry) => {
          const forum = obj(entry);
          return [str(forum?.fid), forum] as const;
        }));
        const sections: TimelineSectionV1[] = [];
        for (const value of list(data.catlist)) {
          const category = obj(value);
          const idValue = id(category?.fid);
          if (!idValue) continue;
          const items: TimelineDescriptorV1[] = [];
          for (const fid of list(category?.forums)) {
            const forum = forums.get(str(fid));
            if (!forum) continue;
            for (const board of [forum, ...list(forum.sublist).map(obj)]) {
              const boardId = id(board?.fid);
              const name = str(board?.name);
              if (boardId && name) items.push({ id: "forum-" + boardId, title: { value: name }, icon: "Channel", parameters: { fid: boardId } });
            }
          }
          if (items.length) sections.push({
            id: "section-" + idValue,
            title: { value: str(category?.name) || "版面" },
            timelines: { items, endReached: true },
          });
        }
        return { items: sections, endReached: true };
      },
    },
    profile: {
      async byId({ key: { id: uid } }, context) {
        if (!id(uid)) fail("NotFound", "找不到这个 S1 用户");
        return loadProfile({ uid }, context);
      },
      async byHandle({ handle }, context) { return loadProfile({ username: handle }, context); },
    },
    post: {
      async detail({ key: { id: keyId } }, context) {
        return { post: await loadPost(keyId, await cookiesFor(context)) };
      },
      async context(request, context) {
        const ref = postRef(request.key.id);
        const cookies = await cookiesFor(context);
        if (ref.pid) {
          const items: TimelineItemV1[] = request.page.direction === "refresh"
            ? [{ type: "post", post: await loadPost(request.key.id, cookies) }] : [];
          return { items, endReached: true };
        }
        const position = cursor(request.page);
        const { thread, rows, hasMore } = await loadThread(ref.tid, position.batch, cookies);
        const items: TimelineItemV1[] = rows.flatMap((row) => {
          const pid = id(row.pid);
          if (!pid || (position.batch > 1 && Number(row.first) === 1)) return [];
          const keyId = Number(row.first) === 1 ? ref.tid : "p" + ref.tid + "-" + pid + "-" + position.batch;
          return [{ type: "post", post: floor(row, thread, ref.tid, keyId, position.batch) }];
        });
        return slice(items, request.page, position, hasMore);
      },
    },
  },
});

async function api(module: string, params: Record<string, string>, cookies: Cookie[]): Promise<Row> {
  const query = Object.entries(params).map(([key, value]) => "&" + key + "=" + encodeURIComponent(value)).join("");
  const response = await flare.http.request({
    url: BASE + API + module + "&version=4" + query,
    cookies,
    headers: { Accept: "application/json", Referer: BASE },
  });
  if (response.status === 401 || response.status === 403) fail("AuthenticationRequired", "请登录 S1 后访问");
  if (response.status === 404) fail("NotFound", "S1 页面不存在");
  if (response.status >= 400) fail("Remote", "S1 暂时无法返回数据");
  let root: Row | undefined;
  try { root = obj(JSON.parse(response.body)); } catch { fail("InvalidResponse", "S1 返回的数据不完整"); }
  const message = obj(root?.Message);
  const data = obj(root?.Variables);
  const code = str(message?.messageval);
  if (/not_loggedin|login_before|login_required|group_nopermission/.test(code)) {
    fail("AuthenticationRequired", str(message?.messagestr) || "这个版面需要登录或相应权限");
  }
  if (!data) fail("InvalidResponse", "S1 没有返回论坛数据");
  return data;
}

async function cookiesFor(context: PluginInvocationContextV1): Promise<Cookie[]> {
  if (context.scope !== "account" || !context.credentialAvailable) return [];
  return list(obj(await flare.credential.read())?.cookies).flatMap((item) => {
    const cookie = obj(item);
    const name = str(cookie?.name);
    const value = str(cookie?.value);
    return name && value ? [{ name, value }] : [];
  });
}

async function loadProfile(params: Record<string, string>, context: PluginInvocationContextV1): Promise<ProfileV1> {
  const data = await api("profile", params, await cookiesFor(context));
  const space = obj(data.space);
  const profile = user(id(space?.uid), str(space?.username));
  if (!profile || (params.uid && params.uid !== profile.key.id)) fail("NotFound", "找不到这个 S1 用户");
  return profile;
}

async function loadThread(tid: string, batch: number, cookies: Cookie[]) {
  const data = await api("viewthread", { tid, page: String(batch) }, cookies);
  const thread = obj(data.thread);
  const rows = list(data.postlist).map(obj).filter((row): row is Row => row !== undefined);
  if (!thread || !rows.length) fail("NotFound", "帖子不可见、已删除或没有访问权限");
  const total = number(thread.replies);
  const size = number(data.ppp) ?? 40;
  const hasMore = total !== undefined && total + 1 > batch * size && rows.length > 0;
  return { thread, rows, hasMore };
}

async function loadPost(keyId: string, cookies: Cookie[]): Promise<PostV1> {
  const { tid, pid, batch } = postRef(keyId);
  const data = await loadThread(tid, batch, cookies);
  const row = pid ? data.rows.find((row) => id(row.pid) === pid) : data.rows.find((row) => Number(row.first) === 1);
  if (!row) fail("NotFound", "找不到这层内容");
  return floor(row, data.thread, tid, keyId, batch);
}

function postRef(keyId: string) {
  if (id(keyId)) return { tid: keyId, batch: 1, pid: undefined };
  const reply = /^p(\d+)-(\d+)-(\d+)$/.exec(keyId);
  if (!reply) fail("NotFound", "无法识别这个帖子");
  return { tid: reply[1], pid: reply[2], batch: Number(reply[3]) };
}

function preview(thread: Row, tid: string, fid: string, forum: string): PostV1 {
  const title = decode(str(thread.subject));
  const body = Array.from(decode(str(thread.message).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim());
  const excerpt = body.length > 136 ? body.slice(0, 136).join("").trimEnd() + "…" : body.join("");
  const media: MediaV1[] = [];
  for (const entry of list(thread.attachmentImagePreviewList)) {
    const attachment = obj(entry);
    const path = str(attachment?.attachment);
    if (!path || Number(attachment?.remote) || Number(attachment?.readperm) || Number(attachment?.price)) continue;
    const url = https("data/attachment/forum/" + path);
    if (url) media.push({ id: tid + "-m" + media.length, type: /\.gif$/i.test(path) ? "gif" : "image", url,
      width: number(attachment?.width), height: number(attachment?.height) });
    if (media.length >= 4) break;
  }
  return {
    key: key(tid), author: user(id(thread.authorid), str(thread.author)),
    createdAt: time(thread.dbdateline ?? thread.dateline),
    content: { format: "html", value: "<b>" + escape(title) + "</b>" + (excerpt ? "<br>" + escape(excerpt) : "") },
    media, url: BASE + "thread-" + tid + "-1-1.html",
    repliesCount: number(thread.replies),
    sourceChannel: forum ? { id: fid, name: decode(forum) } : undefined,
    sourceLanguages: LANGUAGE,
  };
}

function floor(row: Row, thread: Row, tid: string, keyId: string, batch: number): PostV1 {
  const root = keyId === tid;
  const media: MediaV1[] = [];
  const html = str(row.message).replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const url = https(attr(tag, "file") || attr(tag, "data-original") || attr(tag, "src"));
      if (!url) return "";
      if (url.includes("/smiley/")) return '<img src="' + escape(url) + '">';
      if (!media.some((item) => item.url === url) && media.length < 12) {
        media.push({ id: keyId + "-m" + media.length, type: /\.gif(?:$|[?#])/i.test(url) ? "gif" : "image", url });
      }
      return "";
    }).replace(/(?:<br\s*\/?\s*>\s*){3,}/gi, "<br><br>")
    .replace(/\bhref=(["'])([^"']*)\1/gi, (_match, _quote, value: string) => {
      const url = https(value);
      return url ? 'href="' + escape(url) + '"' : "";
    }).trim();
  return {
    key: key(keyId), author: user(id(row.authorid), str(row.author)),
    createdAt: time(row.dbdateline ?? row.dateline),
    content: { format: "html", value: (root ? "<b>" + escape(decode(str(thread.subject))) + "</b><br><br>" : "") + (html || " ") },
    media, replyTo: root ? undefined : key(tid),
    url: BASE + "thread-" + tid + "-" + batch + "-1.html" + (root ? "" : "#pid" + str(row.pid)),
    repliesCount: root ? number(thread.replies) : undefined,
    sourceLanguages: LANGUAGE,
  };
}

function user(uid: string | undefined, name: string, avatar = ""): ProfileV1 | undefined {
  if (!uid || !name) return undefined;
  return { key: key(uid), handle: decode(name), displayName: decode(name),
    avatarUrl: https(avatar || "https://avatar.stage1st.com/forum/uc_server/avatar.php?uid=" + uid + "&size=middle"),
    url: BASE + "home.php?mod=space&uid=" + uid };
}

function cursor(page: PageRequestV1) {
  if (page.direction === "refresh") return { batch: 1, skip: 0 };
  const match = /^(\d+):(\d+)$/.exec(page.cursor ?? "");
  if (page.direction !== "older" || !match || !id(match[1]) || !Number.isSafeInteger(Number(match[2]))) fail("Validation", "分页位置无效");
  return { batch: Number(match[1]), skip: Number(match[2]) };
}
function slice<T>(rows: T[], page: PageRequestV1, position: { batch: number; skip: number }, hasMore: boolean): PageV1<T> {
  const end = position.skip + page.limit;
  const olderCursor = end < rows.length ? position.batch + ":" + end : hasMore ? (position.batch + 1) + ":0" : undefined;
  return { items: rows.slice(position.skip, end), olderCursor, endReached: !olderCursor };
}
function https(value: string): string | undefined {
  let url = decode(value).trim();
  if (!url || /^(?:javascript|data|mailto):/i.test(url)) return undefined;
  if (url.startsWith("//")) url = "https:" + url;
  else if (/^http:\/\//i.test(url)) url = url.replace(/^http:/i, "https:");
  else if (url.startsWith("/")) url = ORIGIN + url;
  else if (!/^https:/i.test(url)) url = BASE + url;
  return /^https:\/\/[^/\s@]+(?:\/|$)/i.test(url) && !/[\s<>"]/u.test(url) ? url : undefined;
}
function time(value: unknown): string {
  const epoch = number(value);
  if (epoch && epoch < 10000000000) return new Date(epoch * 1000).toISOString();
  const date = new Date(str(value).replace(" ", "T") + ":00+08:00");
  return Number.isFinite(date.getTime()) ? date.toISOString() : "1970-01-01T00:00:00.000Z";
}
function obj(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function str(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function id(value: unknown): string | undefined { const v = str(value); return /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) ? v : undefined; }
function number(value: unknown): number | undefined { const v = str(value); return /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined; }
function key(id: string): EntityKeyV1 { return { id, host: HOST }; }
function attr(tag: string, name: string): string {
  const m = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
}
function decode(value: string): string {
  return value.replace(/&(quot|lt|gt|nbsp|amp|#039|#39);/g, (_, name: string) =>
    ({ quot: '"', lt: "<", gt: ">", nbsp: " ", amp: "&", "#039": "'", "#39": "'" })[name] ?? "");
}
function escape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fail(code: PluginErrorCodeV1, message: string): never { throw flare.error({ code, message: { value: message } }); }
