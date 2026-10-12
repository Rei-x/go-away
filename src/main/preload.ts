import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("goAway", {
  currentBreak: () => ipcRenderer.invoke("break:current"),
});
