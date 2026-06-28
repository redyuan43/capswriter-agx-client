import { useState, useEffect, useCallback } from "react";
import { Activity, Play, Square, Plus, Trash2, Edit, AlertTriangle, Cpu, Clock } from "lucide-react";
import { Button } from "./ui/button";
import MonitorConfigModal from "./MonitorConfigModal";

const ProcessMonitorPanel = () => {
  const [configs, setConfigs] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [showModal, setShowModal] = useState(false);
  const [editingConfig, setEditingConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadConfigs = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.getMonitorConfigs();
      if (result.success) {
        setConfigs(result.configs);
      }
    } catch (error) {
      console.error("加载监控配置失败:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.getAllMonitorsStatus();
      if (result.success) {
        const statusMap = {};
        result.statuses.forEach((s) => {
          statusMap[s.id] = s;
        });
        setStatuses(statusMap);
      }
    } catch (error) {
      console.error("加载监控状态失败:", error);
    }
  }, []);

  useEffect(() => {
    loadConfigs().then(() => {
      loadStatuses();
    });
  }, [loadConfigs, loadStatuses]);

  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubStatus = window.electronAPI.onMonitorStatusUpdate((status) => {
      setStatuses((prev) => ({
        ...prev,
        [status.id]: status,
      }));
    });

    const unsubAlert = window.electronAPI.onMonitorAlert((alert) => {
      console.log("监控报警:", alert);
    });

    const unsubError = window.electronAPI.onMonitorError((error) => {
      console.error("监控错误:", error);
    });

    const unsubStopped = window.electronAPI.onMonitorStopped((data) => {
      setStatuses((prev) => {
        const newStatuses = { ...prev };
        delete newStatuses[data.id];
        return newStatuses;
      });
    });

    return () => {
      if (unsubStatus) unsubStatus();
      if (unsubAlert) unsubAlert();
      if (unsubError) unsubError();
      if (unsubStopped) unsubStopped();
    };
  }, []);

  const handleAddConfig = () => {
    setEditingConfig(null);
    setShowModal(true);
  };

  const handleEditConfig = (config) => {
    setEditingConfig(config);
    setShowModal(true);
  };

  const handleDeleteConfig = async (id) => {
    if (!window.electronAPI) return;
    if (!confirm("确定要删除这个监控配置吗？")) return;

    try {
      await window.electronAPI.deleteMonitorConfig(id);
      setConfigs((prev) => prev.filter((c) => c.id !== id));
      setStatuses((prev) => {
        const newStatuses = { ...prev };
        delete newStatuses[id];
        return newStatuses;
      });
    } catch (error) {
      console.error("删除监控配置失败:", error);
    }
  };

  const handleStartMonitor = async (id) => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.startMonitor(id);
      if (result?.status) {
        setStatuses((prev) => ({
          ...prev,
          [id]: result.status,
        }));
      }
      if (result.success) {
        setStatuses((prev) => ({
          ...prev,
          [id]: prev[id] || {
            id,
            status: "starting",
            cpu: 0,
            timestamp: Date.now(),
          },
        }));
      } else if (result.error !== "监控已在运行") {
        alert(`启动监控失败: ${result.error}`);
      }
    } catch (error) {
      console.error("启动监控失败:", error);
    }
  };

  const handleStopMonitor = async (id) => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.stopMonitor(id);
    } catch (error) {
      console.error("停止监控失败:", error);
    }
  };

  const handleSaveConfig = async (config) => {
    if (!window.electronAPI) return;
    try {
      if (editingConfig) {
        const result = await window.electronAPI.updateMonitorConfig(editingConfig.id, config);
        if (result.success) {
          setConfigs((prev) =>
            prev.map((c) => (c.id === editingConfig.id ? result.config : c))
          );
        }
      } else {
        const result = await window.electronAPI.addMonitorConfig(config);
        if (result.success) {
          setConfigs((prev) => [...prev, result.config]);
        }
      }
      setShowModal(false);
      setEditingConfig(null);
    } catch (error) {
      console.error("保存监控配置失败:", error);
    }
  };

  const getStatusColor = (status) => {
    switch (status?.status) {
      case "running":
        return "text-green-500";
      case "idle":
        return "text-yellow-500";
      case "alert":
        return "text-red-500";
      case "error":
        return "text-red-500";
      case "exited":
        return "text-gray-500";
      default:
        return "text-gray-400";
    }
  };

  const getStatusText = (status) => {
    switch (status?.status) {
      case "running":
        return "运行中";
      case "idle":
        return "空闲";
      case "alert":
        return "报警";
      case "error":
        return "错误";
      case "exited":
        return "已退出";
      case "starting":
        return "启动中";
      default:
        return "已停止";
    }
  };

  const isRunning = (id) => {
    return statuses[id]?.status && statuses[id].status !== "stopped";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-500 text-sm">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
            进程监控
          </h3>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
            监控进程 CPU 使用率，低使用率时发出音频提醒
          </p>
        </div>
        <Button
          onClick={handleAddConfig}
          size="sm"
          className="flex items-center gap-1"
        >
          <Plus className="w-4 h-4" />
          添加监控
        </Button>
      </div>

      {configs.length === 0 ? (
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-6 text-center">
          <Activity className="w-10 h-10 text-gray-400 mx-auto mb-3" />
          <p className="text-sm text-gray-600 dark:text-gray-400">
            暂无监控配置，点击"添加监控"开始
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => {
            const status = statuses[config.id];
            const running = isRunning(config.id);

            return (
              <div
                key={config.id}
                className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`flex items-center gap-1 ${getStatusColor(status)}`}>
                      {status?.status === "alert" ? (
                        <AlertTriangle className="w-4 h-4" />
                      ) : (
                        <Activity className="w-4 h-4" />
                      )}
                      <span className="text-sm font-medium">
                        {config.usePid ? `PID: ${config.pid}` : config.name}
                      </span>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(status)} bg-opacity-20`}>
                      {getStatusText(status)}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {running ? (
                      <Button
                        onClick={() => handleStopMonitor(config.id)}
                        size="sm"
                        variant="outline"
                        className="flex items-center gap-1"
                      >
                        <Square className="w-3 h-3" />
                        停止
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleStartMonitor(config.id)}
                        size="sm"
                        className="flex items-center gap-1"
                      >
                        <Play className="w-3 h-3" />
                        启动
                      </Button>
                    )}
                    <Button
                      onClick={() => handleEditConfig(config)}
                      size="sm"
                      variant="ghost"
                      className="p-1"
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      onClick={() => handleDeleteConfig(config.id)}
                      size="sm"
                      variant="ghost"
                      className="p-1 text-red-500 hover:text-red-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {running && status && (
                  <div className="mt-3 flex items-center gap-4 text-xs text-gray-600 dark:text-gray-400">
                    <div className="flex items-center gap-1">
                      <Cpu className="w-3 h-3" />
                      CPU: {status.cpu?.toFixed(2) || 0}%
                    </div>
                    {status.status === "idle" && (
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        空闲: {status.idleTime?.toFixed(1) || 0}s / {status.idleDuration || config.idleDuration}s
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-2 text-xs text-gray-500 dark:text-gray-500">
                  阈值: {config.cpuThreshold}% | 间隔: {config.checkInterval}s | 空闲判定: {config.idleDuration}s
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <MonitorConfigModal
          config={editingConfig}
          onSave={handleSaveConfig}
          onClose={() => {
            setShowModal(false);
            setEditingConfig(null);
          }}
        />
      )}
    </div>
  );
};

export default ProcessMonitorPanel;
