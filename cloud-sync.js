// Optional cloud sync: if firebase-config.js has real credentials filled
// in, revealed-region state is also mirrored to a Firestore document keyed
// by the user's self-chosen ID, so it survives a cache clear / new device -
// not just this one browser's localStorage. No password: anyone who enters
// the same ID sees/overwrites the same data, by design (see index.html's
// hint text) - this is a lightweight "just my own ID" shared journal, not a
// real login system.
(function () {
  "use strict";

  var USER_ID_KEY = "travelmap.userId";
  var userId = "";
  try {
    userId = localStorage.getItem(USER_ID_KEY) || "";
  } catch (e) {
    /* storage unavailable, ignore */
  }
  if (!userId) {
    location.href = "index.html";
    return;
  }

  var cfg = window.FIREBASE_CONFIG || {};
  var enabled = !!(cfg.apiKey && cfg.projectId);
  var db = null;
  if (enabled) {
    try {
      firebase.initializeApp(cfg);
      db = firebase.firestore();
    } catch (e) {
      enabled = false;
    }
  }

  function docRef() {
    return db.collection("travelmap_users").doc(userId);
  }

  window.CloudSync = {
    userId: userId,
    enabled: enabled,

    changeUserId: function () {
      var next = window.prompt("사용할 아이디를 입력하세요", userId);
      if (!next) return;
      next = next.trim();
      if (!next || next === userId) return;
      try {
        localStorage.setItem(USER_ID_KEY, next);
      } catch (e) {
        /* storage unavailable, ignore */
      }
      location.reload();
    },

    // Resolves to an array of revealed region ids from the cloud, or null
    // if cloud sync isn't configured/reachable (caller should just keep
    // whatever it already restored from localStorage in that case).
    loadRevealed: function () {
      if (!enabled) return Promise.resolve(null);
      return docRef()
        .get()
        .then(function (snap) {
          if (!snap.exists) return [];
          var data = snap.data();
          return Array.isArray(data.revealed) ? data.revealed : [];
        })
        .catch(function () {
          return null;
        });
    },

    // Fire-and-forget write; local save already happened synchronously so
    // there's nothing for the caller to await.
    saveRevealed: function (ids) {
      if (!enabled) return;
      docRef()
        .set({ revealed: ids, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .catch(function () {
          /* offline or misconfigured - localStorage already has the data */
        });
    },
  };
})();
