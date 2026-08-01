function desktopWindowChrome(platform = process.platform, dark = false) {
  if (platform !== "win32") return {};
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: dark
      ? { color: "#191713", symbolColor: "#ede6d6", height: 34 }
      : { color: "#f4f3f0", symbolColor: "#24211c", height: 34 }
  };
}

module.exports = { desktopWindowChrome };
