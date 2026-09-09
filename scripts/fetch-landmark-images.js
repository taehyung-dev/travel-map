// One-time (re-runnable) fetch of a real representative photo per landmark
// name in data/landmarks.js, from Korean Wikipedia / Wikimedia Commons
// (openly licensed, safe to embed). Writes data/landmark-images.js as
// window.LANDMARK_IMAGES = { "<landmark name>": { src: "data:...", credit } }
// keyed by landmark NAME (several regions share a landmark, e.g. 지리산).
//
// Published Artifacts can't fetch arbitrary external images at runtime (CSP
// only allows a few script/font hosts) - images have to be embedded in the
// page at build time, hence this offline fetch step instead of a live
// lookup from app.js.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const UA =
  "TravelMapApp/1.0 (personal hobby project; contact: local-user)";

function apiGet(url) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

async function summaryFor(title) {
  const url =
    "https://ko.wikipedia.org/api/rest_v1/page/summary/" +
    encodeURIComponent(title);
  const res = await apiGet(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.type === "disambiguation") return null;
  return json;
}

async function searchTitle(query) {
  const url =
    "https://ko.wikipedia.org/w/api.php?action=query&list=search&format=json" +
    "&srlimit=1&srsearch=" +
    encodeURIComponent(query);
  const res = await apiGet(url);
  if (!res.ok) return null;
  const json = await res.json();
  var hit = json.query && json.query.search && json.query.search[0];
  return hit ? hit.title : null;
}

async function fetchImageDataUri(imgUrl) {
  const res = await fetch(imgUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return "data:" + contentType + ";base64," + buf.toString("base64");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveLandmark(name) {
  var summary = await summaryFor(name);
  if (!summary || !summary.thumbnail) {
    var altTitle = await searchTitle(name);
    if (altTitle && altTitle !== name) {
      summary = await summaryFor(altTitle);
    }
  }
  if (!summary || !summary.thumbnail) return null;
  var dataUri = await fetchImageDataUri(summary.thumbnail.source);
  if (!dataUri) return null;
  return {
    src: dataUri,
    credit: summary.title,
    sourceUrl:
      "https://ko.wikipedia.org/wiki/" + encodeURIComponent(summary.title),
  };
}

async function main() {
  var landmarksSrc = fs.readFileSync(
    path.join(root, "data/landmarks.js"),
    "utf8"
  );
  var sandbox = { window: {} };
  new Function("window", landmarksSrc)(sandbox.window);
  var LANDMARKS = sandbox.window.LANDMARKS;

  var names = [...new Set(Object.values(LANDMARKS).map((v) => v.name))];
  console.log("resolving", names.length, "unique landmark names");

  var out = {};
  var failed = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    try {
      var result = await resolveLandmark(name);
      if (result) {
        out[name] = result;
        console.log(
          "[" + (i + 1) + "/" + names.length + "]",
          name,
          "->",
          result.credit,
          Math.round(result.src.length / 1024) + "KB"
        );
      } else {
        failed.push(name);
        console.log("[" + (i + 1) + "/" + names.length + "]", name, "-> NO IMAGE");
      }
    } catch (e) {
      failed.push(name);
      console.log("[" + (i + 1) + "/" + names.length + "]", name, "-> ERROR", e.message);
    }
    await sleep(120);
  }

  fs.writeFileSync(
    path.join(root, "data/landmark-images.js"),
    "window.LANDMARK_IMAGES = " + JSON.stringify(out) + ";"
  );
  console.log("wrote", Object.keys(out).length, "images,", failed.length, "failed");
  if (failed.length) console.log("failed:", failed.join(", "));
}

main();
