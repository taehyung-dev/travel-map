// Second-chance image source for landmarks Korean Wikipedia's summary API
// couldn't resolve (no matching article, or an article with no page
// image): search Wikimedia Commons' File namespace directly instead of
// going through a Wikipedia article. Commons has far more Korean-place
// photos than have an infobox-linked Wikipedia article, so this recovers
// a chunk of the misses. Reads data/_failed-landmarks.json (built by a
// one-off query against landmarks.js + landmark-images.js), merges any
// resolved images into data/landmark-images.js.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const UA = "TravelMapApp/1.0 (personal hobby project; contact: local-user)";

function apiGet(url) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

async function searchCommons(query) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
    "&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=360&format=json" +
    "&gsrsearch=" +
    encodeURIComponent(query + " -logo -map -icon");
  const res = await apiGet(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!json.query || !json.query.pages) return [];
  return Object.values(json.query.pages)
    .filter((p) => p.imageinfo && p.imageinfo[0])
    .map((p) => ({ title: p.title, info: p.imageinfo[0] }))
    .filter((p) => /\.(jpe?g|png)$/i.test(p.title))
    .filter((p) => p.info.width >= 300 && p.info.height >= 200);
}

async function fetchImageDataUri(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return "data:" + contentType + ";base64," + buf.toString("base64");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOne(regionName, landmarkName) {
  var queries = [regionName + " " + landmarkName, landmarkName];
  for (var qi = 0; qi < queries.length; qi++) {
    var results = await searchCommons(queries[qi]);
    if (results.length) {
      var pick = results[0];
      var thumbUrl = pick.info.thumburl || pick.info.url;
      var dataUri = await fetchImageDataUri(thumbUrl);
      if (dataUri) {
        return {
          src: dataUri,
          credit: pick.title.replace(/^File:/, "").replace(/\.(jpe?g|png)$/i, ""),
          sourceUrl: pick.info.descriptionurl || thumbUrl,
        };
      }
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  var failed = JSON.parse(
    fs.readFileSync(path.join(root, "data/_failed-landmarks.json"), "utf8")
  );

  var existingSrc = fs.readFileSync(path.join(root, "data/landmark-images.js"), "utf8");
  var sandbox = { window: {} };
  new Function("window", existingSrc)(sandbox.window);
  var out = sandbox.window.LANDMARK_IMAGES || {};

  var stillFailed = [];
  for (var i = 0; i < failed.length; i++) {
    var item = failed[i];
    if (out[item.landmarkName]) continue;
    try {
      var result = await resolveOne(item.regionName, item.landmarkName);
      if (result) {
        out[item.landmarkName] = result;
        console.log(
          "[" + (i + 1) + "/" + failed.length + "]",
          item.landmarkName,
          "->",
          result.credit,
          Math.round(result.src.length / 1024) + "KB"
        );
      } else {
        stillFailed.push(item.landmarkName);
        console.log("[" + (i + 1) + "/" + failed.length + "]", item.landmarkName, "-> no result");
      }
    } catch (e) {
      stillFailed.push(item.landmarkName);
      console.log("[" + (i + 1) + "/" + failed.length + "]", item.landmarkName, "-> ERROR", e.message);
    }
    await sleep(300);
  }

  fs.writeFileSync(
    path.join(root, "data/landmark-images.js"),
    "window.LANDMARK_IMAGES = " + JSON.stringify(out) + ";"
  );
  console.log("total resolved", Object.keys(out).length, "of 185");
  if (stillFailed.length) console.log("still failed:", stillFailed.join(", "));
}

main();
