// Final targeted pass: explicit alternate Wikipedia titles for the names
// that plain search still couldn't resolve (disambiguation pages, informal
// names with no dedicated article, or titles the search API just didn't
// rank first).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const UA = "TravelMapApp/1.0 (personal hobby project; contact: local-user)";

const OVERRIDES = {
  태화강: "태화강국가정원",
  서울식물원: "서울식물원",
  국립현충원: "국립서울현충원",
  안양예술공원: "안양예술공원",
  구리한강시민공원: "구리시",
  미리내성지: "미리내성지",
  장흥유원지: "장흥자연휴양림",
  두물머리: "두물머리",
  환선굴: "환선굴",
  홍천강: "홍천강",
  "정선 아리랑": "정선아리랑",
  내린천: "내린천",
  산막이옛길: "산막이옛길",
  품바축제: "품바",
  좌구산: "좌구산",
  공산성: "공산성",
  관촉사: "관촉사",
  삽교호: "삽교호",
  "신성리 갈대밭": "신성리갈대밭",
  남당항: "홍성군",
  치즈마을: "임실치즈테마파크",
  고추장마을: "순창전통고추장민속마을",
  "보성 녹차밭": "대한다원",
  "화순 고인돌": "화순고인돌유적",
  정남진: "장흥군",
  회산백련지: "회산백련지",
  백수해안도로: "백수해안도로",
  청산도: "청산도",
  퍼플섬: "안좌도",
  보현산천문대: "보현산천문대",
  갓바위: "팔공산 갓바위",
  인각사: "인각사",
  조문국사적지: "의성군",
  "성주 참외밭": "성주군",
  칠곡보: "칠곡군",
  동피랑마을: "동피랑",
  바람의언덕: "거제 바람의 언덕",
  "진해 군항제": "진해군항제",
  정암루: "정암루",
  화개장터: "화개장터",
};

function apiGet(url) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

async function summaryFor(title) {
  const url =
    "https://ko.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
  const res = await apiGet(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.type === "disambiguation") return null;
  return json;
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

async function main() {
  var existingSrc = fs.readFileSync(path.join(root, "data/landmark-images.js"), "utf8");
  var sandbox = { window: {} };
  new Function("window", existingSrc)(sandbox.window);
  var out = sandbox.window.LANDMARK_IMAGES || {};

  var names = Object.keys(OVERRIDES);
  var stillFailed = [];
  for (var i = 0; i < names.length; i++) {
    var origName = names[i];
    if (out[origName]) continue; // already resolved by a later concurrent pass
    var altTitle = OVERRIDES[origName];
    try {
      var summary = await summaryFor(altTitle);
      if (summary && summary.thumbnail) {
        var dataUri = await fetchImageDataUri(summary.thumbnail.source);
        if (dataUri) {
          out[origName] = {
            src: dataUri,
            credit: summary.title,
            sourceUrl:
              "https://ko.wikipedia.org/wiki/" + encodeURIComponent(summary.title),
          };
          console.log(
            "[" + (i + 1) + "/" + names.length + "]",
            origName,
            "(" + altTitle + ") ->",
            summary.title,
            Math.round(dataUri.length / 1024) + "KB"
          );
        } else {
          stillFailed.push(origName);
          console.log("[" + (i + 1) + "/" + names.length + "]", origName, "-> image dl failed");
        }
      } else {
        stillFailed.push(origName);
        console.log("[" + (i + 1) + "/" + names.length + "]", origName, "-> still no summary/thumbnail");
      }
    } catch (e) {
      stillFailed.push(origName);
      console.log("[" + (i + 1) + "/" + names.length + "]", origName, "-> ERROR", e.message);
    }
    await sleep(350);
  }

  fs.writeFileSync(
    path.join(root, "data/landmark-images.js"),
    "window.LANDMARK_IMAGES = " + JSON.stringify(out) + ";"
  );
  console.log("total resolved", Object.keys(out).length, "of 185");
  if (stillFailed.length) console.log("still failed:", stillFailed.join(", "));
}

main();
