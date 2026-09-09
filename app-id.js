(function () {
  "use strict";

  var USER_ID_KEY = "travelmap.userId";
  var input = document.getElementById("userIdInput");
  var startBtn = document.getElementById("startBtn");

  var saved = "";
  try {
    saved = localStorage.getItem(USER_ID_KEY) || "";
  } catch (e) {
    /* storage unavailable, ignore */
  }
  if (saved) input.value = saved;

  function persistAndGo(e) {
    var id = input.value.trim();
    if (!id) {
      e.preventDefault();
      input.focus();
      return;
    }
    try {
      localStorage.setItem(USER_ID_KEY, id);
    } catch (err) {
      /* storage unavailable, ignore */
    }
    // let the default <a href="map.html"> navigation proceed
  }

  startBtn.addEventListener("click", persistAndGo);
})();
