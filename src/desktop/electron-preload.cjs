const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wwritingDesktop", {
  platform: process.platform,
  shell: "electron",
  selectProjectFolder: () => ipcRenderer.invoke("wwriting:select-project-folder")
});
