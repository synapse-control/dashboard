"use strict";
(() => {
  let pick = "light";
  try { pick = localStorage.getItem("theme") || "light"; } catch {}
  const dark = pick === "dark" || (pick === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
