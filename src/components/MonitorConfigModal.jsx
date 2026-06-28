import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const MonitorConfigModal = ({ config, onSave, onClose }) => {
  const [formData, setFormData] = useState({
    name: "",
    usePid: false,
    pid: "",
    cpuThreshold: 1.0,
    idleDuration: 30,
    checkInterval: 2,
  });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (config) {
      setFormData({
        name: config.name || "",
        usePid: config.usePid || false,
        pid: config.pid || "",
        cpuThreshold: config.cpuThreshold || 1.0,
        idleDuration: config.idleDuration || 30,
        checkInterval: config.checkInterval || 2,
      });
    }
  }, [config]);

  const handleChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
    setErrors((prev) => ({
      ...prev,
      [field]: null,
    }));
  };

  const validate = () => {
    const newErrors = {};

    if (!formData.usePid) {
      if (!formData.name.trim()) {
        newErrors.name = "请输入进程名称";
      }
    } else {
      if (!formData.pid || isNaN(parseInt(formData.pid))) {
        newErrors.pid = "请输入有效的 PID";
      }
    }

    if (formData.cpuThreshold < 0 || formData.cpuThreshold > 100) {
      newErrors.cpuThreshold = "CPU 阈值应在 0-100 之间";
    }

    if (formData.idleDuration < 1) {
      newErrors.idleDuration = "空闲判定时长至少 1 秒";
    }

    if (formData.checkInterval < 0.5) {
      newErrors.checkInterval = "检查间隔至少 0.5 秒";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    const saveData = {
      name: formData.usePid ? "" : formData.name.trim(),
      usePid: formData.usePid,
      pid: formData.usePid ? parseInt(formData.pid) : null,
      cpuThreshold: parseFloat(formData.cpuThreshold),
      idleDuration: parseInt(formData.idleDuration),
      checkInterval: parseFloat(formData.checkInterval),
    };

    onSave(saveData);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
            {config ? "编辑监控" : "添加监控"}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  checked={!formData.usePid}
                  onChange={() => handleChange("usePid", false)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">进程名</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  checked={formData.usePid}
                  onChange={() => handleChange("usePid", true)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">PID</span>
              </label>
            </div>

            {!formData.usePid ? (
              <div>
                <Label htmlFor="name">进程名称</Label>
                <Input
                  id="name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  placeholder="例如: python, node, chrome"
                  className={errors.name ? "border-red-500" : ""}
                />
                {errors.name && (
                  <p className="text-xs text-red-500 mt-1">{errors.name}</p>
                )}
              </div>
            ) : (
              <div>
                <Label htmlFor="pid">进程 PID</Label>
                <Input
                  id="pid"
                  type="number"
                  value={formData.pid}
                  onChange={(e) => handleChange("pid", e.target.value)}
                  placeholder="例如: 12345"
                  className={errors.pid ? "border-red-500" : ""}
                />
                {errors.pid && (
                  <p className="text-xs text-red-500 mt-1">{errors.pid}</p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="cpuThreshold">CPU 阈值 (%)</Label>
              <Input
                id="cpuThreshold"
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={formData.cpuThreshold}
                onChange={(e) => handleChange("cpuThreshold", e.target.value)}
                className={errors.cpuThreshold ? "border-red-500" : ""}
              />
              {errors.cpuThreshold && (
                <p className="text-xs text-red-500 mt-1">{errors.cpuThreshold}</p>
              )}
            </div>

            <div>
              <Label htmlFor="idleDuration">空闲时长 (秒)</Label>
              <Input
                id="idleDuration"
                type="number"
                min="1"
                value={formData.idleDuration}
                onChange={(e) => handleChange("idleDuration", e.target.value)}
                className={errors.idleDuration ? "border-red-500" : ""}
              />
              {errors.idleDuration && (
                <p className="text-xs text-red-500 mt-1">{errors.idleDuration}</p>
              )}
            </div>

            <div>
              <Label htmlFor="checkInterval">检查间隔 (秒)</Label>
              <Input
                id="checkInterval"
                type="number"
                step="0.5"
                min="0.5"
                value={formData.checkInterval}
                onChange={(e) => handleChange("checkInterval", e.target.value)}
                className={errors.checkInterval ? "border-red-500" : ""}
              />
              {errors.checkInterval && (
                <p className="text-xs text-red-500 mt-1">{errors.checkInterval}</p>
              )}
            </div>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-xs text-gray-600 dark:text-gray-400">
            <p className="mb-1">
              <strong>CPU 阈值：</strong>当进程 CPU 使用率低于此值时，视为空闲状态
            </p>
            <p className="mb-1">
              <strong>空闲时长：</strong>持续空闲超过此时长后，播放音频提醒
            </p>
            <p>
              <strong>检查间隔：</strong>检测 CPU 使用率的时间间隔
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit">
              {config ? "保存" : "添加"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default MonitorConfigModal;
