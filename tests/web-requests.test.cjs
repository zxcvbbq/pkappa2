const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { runInThisContext } = require("node:vm");

const webRequire = createRequire(path.join(__dirname, "../web/package.json"));
const ts = webRequire("typescript");
const { createPinia, setActivePinia } = webRequire("pinia");
const { AxiosError, CanceledError } = webRequire("axios");

// Use the real stores; replace their API imports to control response order.
function loadModule(file, overrides) {
  const filename = path.join(__dirname, "../web/src", file);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, module, exports) {${outputText}\n})`, {
    filename,
  })(
    (id) => (Object.hasOwn(overrides, id) ? overrides[id] : webRequire(id)),
    module,
    module.exports,
  );
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cases = [
  {
    file: "stream",
    store: "useStreamStore",
    api: "getStream",
    action: "fetchStream",
    args: (n) => [n, "none"],
    result: "stream",
    data: (n) => ({
      Stream: { ID: n },
      Data: [],
      Tags: [],
      Converters: [],
      ActiveConverter: "",
    }),
  },
  {
    file: "streams",
    store: "useStreamsStore",
    api: "searchStreams",
    action: "searchStreams",
    args: (n) => [`id:${n}`, 0],
    result: "result",
    data: (n) => ({
      Debug: [],
      Results: [],
      Elapsed: n,
      Offset: 0,
      MoreResults: false,
      DataRegexes: { Client: [], Server: [] },
    }),
  },
  {
    file: "graph",
    store: "useGraphStore",
    api: "getGraph",
    action: "fetchGraph",
    args: (n) => ["1m", ["connections"], [], `id:${n}`, "Active Connections"],
    result: "graph",
    data: (n) => ({
      Min: "2026-10-01T00:00:00Z",
      Max: "2026-10-01T01:00:00Z",
      Delta: 60,
      Aspects: ["connections"],
      Data: [{ Tags: [], Data: [[0, n]] }],
    }),
  },
];

function makeStore(kind, responses) {
  setActivePinia(createPinia());
  const exports = loadModule(`stores/${kind.file}.ts`, {
    "@/apiClient": { [kind.api]: () => responses.shift().promise },
  });
  return exports[kind.store]();
}

test("late responses cannot replace the current stream, search, or graph", async () => {
  for (const kind of cases) {
    const old = deferred();
    const latest = deferred();
    const store = makeStore(kind, [old, latest]);
    const oldRequest = store[kind.action](...kind.args(1));
    const latestRequest = store[kind.action](...kind.args(2));
    latest.resolve(kind.data(2));
    await latestRequest;
    old.resolve(kind.data(1));
    await oldRequest;
    assert.deepEqual(store[kind.result], kind.data(2), kind.file);
    assert.equal(store.running, false, kind.file);
    if (kind.file === "stream") assert.equal(store.id, 2);
    else assert.equal(store.query, "id:2");
  }
});

test("obsolete requests leave the current loading state and errors alone", async () => {
  for (const kind of cases) {
    for (const error of [
      null,
      new AxiosError("old error"),
      new Error("old error"),
    ]) {
      const old = deferred();
      const latest = deferred();
      const store = makeStore(kind, [old, latest]);
      const oldRequest = store[kind.action](...kind.args(1));
      const latestRequest = store[kind.action](...kind.args(2));
      if (error) old.reject(error);
      else old.resolve(kind.data(1));
      await oldRequest;
      assert.equal(store.running, true, kind.file);
      assert.equal(store.error, null, kind.file);
      assert.equal(store[kind.result], null, kind.file);
      latest.resolve(kind.data(2));
      await latestRequest;
      assert.equal(store.running, false, kind.file);
    }
  }
});

test("current failures and cancellations always stop the loading indicator", async () => {
  for (const kind of cases) {
    for (const error of [
      new CanceledError(),
      new AxiosError("offline"),
      new Error("Unexpected response, types mismatch"),
    ]) {
      const response = deferred();
      const store = makeStore(kind, [response]);
      const request = store[kind.action](...kind.args(1));
      response.reject(error);
      if (error instanceof AxiosError) await request;
      else await assert.rejects(request, error);
      assert.equal(store.running, false, kind.file);
      assert.equal(store.error, error.message === "offline" ? "offline" : null);
    }
  }
});

test("pagination appends normally and cannot mix an old page into a new query", async () => {
  const kind = cases[1];
  const page0 = deferred();
  const page1 = deferred();
  const oldPage2 = deferred();
  const newQuery = deferred();
  const store = makeStore(kind, [page0, page1, oldPage2, newQuery]);
  let request = store.searchStreams("service:web", 0);
  page0.resolve({ Offset: 0, Results: [{ Stream: { ID: 1 } }] });
  await request;
  request = store.searchStreams("service:web", 1, true);
  page1.resolve({ Offset: 100, Results: [{ Stream: { ID: 2 } }] });
  await request;
  assert.deepEqual(
    store.result.Results.map((r) => r.Stream.ID),
    [1, 2],
  );
  assert.equal(store.result.Offset, 0);
  assert.equal(store.latestPage, 1);
  const oldRequest = store.searchStreams("service:web", 2, true);
  request = store.searchStreams("service:other", 0);
  newQuery.resolve({ Offset: 0, Results: [{ Stream: { ID: 3 } }] });
  await request;
  oldPage2.resolve({ Offset: 200, Results: [{ Stream: { ID: 4 } }] });
  await oldRequest;
  assert.deepEqual(
    store.result.Results.map((r) => r.Stream.ID),
    [3],
  );
  assert.equal(store.latestPage, 0);
});

test("search and graph cancel only previous requests for their own resource", async () => {
  const requests = [];
  const api = loadModule("apiClient.ts", {
    axios: {
      create: () => ({
        request: (config) => {
          requests.push(config);
          return Promise.resolve({ data: {} });
        },
      }),
    },
    "./apiClient.guard": {},
  }).default;
  await api.perform("post", "/search.json");
  await api.perform("get", "/graph.json");
  assert.equal(requests[0].signal.aborted, false);
  await api.perform("post", "/search.json");
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  await api.perform("get", "/graph.json");
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(requests[2].signal.aborted, false);
});
