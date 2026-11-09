import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../plugin.js", import.meta.url), "utf8");
const context = { scope: "guest", credentialAvailable: false };
const page = { direction: "refresh", limit: 20 };

function register(respond) {
  let plugin;
  vm.runInNewContext(source, {
    defineFlareSocialPlugin(value) { plugin = value; },
    flare: {
      error: ({ code, message }) => Object.assign(new Error(message.value), { code }),
      http: {
        request: async ({ url }) => ({
          status: 200, headers: {}, body: JSON.stringify(respond(new URL(url))),
        }),
      },
    },
  });
  return plugin.capabilities;
}

test("unknown Discuz attachment dimensions do not make an entire page invalid", async () => {
  const { timeline } = register(() => ({
    Variables: {
      forum: { name: "游戏论坛", threads: 1 },
      forum_threadlist: [{
        tid: "2181530", subject: "游戏讨论", authorid: "123", author: "楼主",
        attachmentImagePreviewList: [
          { attachment: "202404/26/example.jpeg", width: "1170", height: "0" },
          { attachment: "202404/26/other.png", width: "0", height: "720" },
        ],
      }],
    },
  }));
  const result = await timeline.page({ timelineId: "forum-4", page }, context);
  const media = result.items[0].post.media;
  assert.equal(media.length, 2);
  assert.equal(media[0].width, 1170);
  assert.equal(media[0].height, undefined);
  assert.equal(media[1].width, undefined);
  assert.equal(media[1].height, 720);
});

test("subforums are named separately and a private subforum reports its access restriction", async () => {
  const { tabCatalog, timeline } = register((url) => url.searchParams.get("module") === "forumindex"
    ? { Variables: {
        catlist: [{ fid: "1", name: "主论坛", forums: ["51"] }],
        forumlist: [{ fid: "51", name: "数码", sublist: [{ fid: "80", name: "摄影区" }] }],
      } }
    : { Variables: { forum_threadlist: [] }, Message: { messageval: "viewperm_login_nopermission//1" } });
  const result = await tabCatalog.page(page, context);
  const child = result.items[0].timelines.items[1];
  assert.equal(child.id, "forum-80");
  assert.equal(child.title.value, "数码 · 摄影区");
  await assert.rejects(timeline.page({ timelineId: child.id, parameters: child.parameters, page }, context),
    { code: "AuthenticationRequired" });
});
