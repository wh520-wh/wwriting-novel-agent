function desktopWindowChrome(platform = process.platform) {
  if (platform !== "win32") return {};
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f4f3f0",
      symbolColor: "#24211c",
      height: 34
    }
  };
}

module.exports = { desktopWindowChrome };
