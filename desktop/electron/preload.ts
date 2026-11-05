import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("mesho", {
  teamPropose: (conversation: string, text: string) =>
    ipcRenderer.invoke("teamPropose", conversation, text),
  teamAmend: (goal: string, revision: string, text: string) =>
    ipcRenderer.invoke("teamAmend", goal, revision, text),
  teamDetails: (goal: string) => ipcRenderer.invoke("teamDetails", goal),
  teamCommit: (goal: string, revision: string, scope: unknown, auto: boolean) =>
    ipcRenderer.invoke("teamCommit", goal, revision, scope, auto),
  teamDecision: (goal: string, action: string, text?: string) =>
    ipcRenderer.invoke("teamDecision", goal, action, text),
  collaborationStart: (conversation: string, goal: string, auto: boolean) =>
    ipcRenderer.invoke("collaborationStart", conversation, goal, auto),
  collaborationDecide: (id: string, action: string, feedback?: string) =>
    ipcRenderer.invoke("collaborationDecide", id, action, feedback),
  chatAnswer: (id: string, text: string) =>
    ipcRenderer.invoke("chatAnswer", id, text),
  openExternal: (url: string) => ipcRenderer.invoke("openExternal", url),
  chatCreate: (c: unknown) => ipcRenderer.invoke("chatCreate", c),
  chatSend: (m: unknown) => ipcRenderer.invoke("chatSend", m),
  chatHistory: (id: string, before?: number) =>
    ipcRenderer.invoke("chatHistory", id, before),
  chatRead: (id: string, seq: number) =>
    ipcRenderer.invoke("chatRead", id, seq),
  chatDelegate: (id: string) => ipcRenderer.invoke("chatDelegate", id),
  chatPublish: (id: string) => ipcRenderer.invoke("chatPublish", id),
  chatRetry: (id: string) => ipcRenderer.invoke("chatRetry", id),
  snapshot: () => ipcRenderer.invoke("snapshot"),
  setup: (config: unknown, invite: string, token: string) =>
    ipcRenderer.invoke("setup", config, invite, token),
  configure: (config: unknown) => ipcRenderer.invoke("configure", config),
  send: (message: unknown) => ipcRenderer.invoke("send", message),
  approve: (id: string) => ipcRenderer.invoke("approve", id),
  reject: (id: string) => ipcRenderer.invoke("reject", id),
  stop: (id: string) => ipcRenderer.invoke("stop", id),
  pause: (value: boolean) => ipcRenderer.invoke("pause", value),
  sync: () => ipcRenderer.invoke("sync"),
  pickDirectory: () => ipcRenderer.invoke("pickDirectory"),
});
