const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mainframe', {
  // 通知主进程分析任务已开始
  notifyJobStarted: () => ipcRenderer.send('job-started'),

  // 通知主进程分析任务已结束（完成/失败/取消）
  notifyJobEnded: () => ipcRenderer.send('job-ended'),

  // 获取后端 URL（端口动态分配）
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // 获取应用版本号
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // 提交反馈（运行日志）
  submitFeedback: (note) => ipcRenderer.invoke('submit-feedback', note),
});
