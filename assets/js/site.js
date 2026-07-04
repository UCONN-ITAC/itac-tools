// Light/dark theme toggle for the ITAC tools site. The initial theme is set by
// a tiny inline script in each page's <head> (before paint) to avoid a flash;
// this file only wires up the toggle button and persists the choice.
(function () {
  function current() {
    var forced = document.documentElement.getAttribute("data-theme");
    if (forced) return forced;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("itac-tools-theme", theme); } catch (e) {}
    var btn = document.querySelector(".theme-toggle");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  }
  function init() {
    var btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    btn.textContent = current() === "dark" ? "☀️" : "🌙";
    btn.addEventListener("click", function () {
      apply(current() === "dark" ? "light" : "dark");
    });
  }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
