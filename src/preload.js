const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  init: call('init'),
  saveSettings: call('save-settings'),
  loginDiscord: call('login-discord'),
  logoutDiscord: call('logout-discord'),
  openAdmin: call('open-admin'),
  listGuilds: call('list-guilds'),
  addServer: call('add-server'),
  removeServer: call('remove-server'),
  loginMicrosoft: call('login-microsoft'),
  loginOffline: call('login-offline'),
  logoutMinecraft: call('logout-minecraft'),
  play: call('play'),
  openFolder: call('open-folder'),
  openReleases: call('open-releases'),
  setMemory: call('set-memory'),
  uploadLog: call('upload-log'),
  installUpdate: call('install-update'),
  ping: call('ping'),
  appVersion: call('app-version'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
