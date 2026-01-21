# Auto Accept for Antigravity

[English](README_EN.md) | **中文**

## 同时运行 3 个 AI 代理，无需人工干预

不再盯着标签页。Auto Accept 让每个 Antigravity 对话自动进行 — 自动接受文件编辑、终端命令和恢复提示。

---

![background mode](https://raw.githubusercontent.com/MunKhin/auto-accept-agent/master/media/background-mode.png)

---

## 为什么选择 Auto Accept？

Antigravity 的多代理工作流程很强大，但每当代理需要批准时就会停下来。

**每小时数十次中断。**

Auto Accept 消除等待：
- ✅ **文件编辑** — 自动应用
- ✅ **终端命令** — 自动执行
- ✅ **重试提示** — 自动确认
- ✅ **卡住的代理** — 自动恢复

---

## 功能特性

### 后台模式 (Pro)
同时运行多个 Antigravity 标签页。所有对话在后台自动接受 — 无需切换标签页。

### 危险命令拦截
内置保护，阻止破坏性命令如 `rm -rf /`。Pro 用户可自定义拦截列表。

### 实时状态指示
可视化指示器显示对话状态：
- **紫色** — 进行中，正在轮询
- **绿色** — 任务完成

### 全平台支持
- ✅ Antigravity
- ✅ Cursor
- ✅ 多窗口
- ✅ 最小化/失焦状态
- ✅ 多实例（智能端口检测）

### 多语言支持
- 🇺🇸 **English**
- 🇨🇳 **简体中文**

插件会自动检测 IDE 语言。如需强制切换，请在设置中修改 `Auto Accept: Language Override`。

---

## 快速开始

1. **安装** 扩展
2. **点击** 状态栏中的 `Auto Accept: OFF`
3. **允许** 一次性快捷方式更新（如有提示）
4. **完成** — Auto Accept 自动激活

扩展静默运行。查看状态栏确认 `Auto Accept: ON`。

---

## 安装方法

### 从 GitHub Releases 安装
1. 前往 [Releases 页面](https://github.com/michaelbarrera21/auto-accept-agent/releases)
2. 下载最新的 `.vsix` 文件
3. 打开 Antigravity / VS Code / Cursor
4. 按 `Ctrl+Shift+P`，输入 `Install from VSIX`
5. 选择下载的 `.vsix` 文件
6. 重启 IDE

---

## Pro 功能对比

| 功能 | 免费版 | Pro |
|------|--------|-----|
| 当前标签页自动接受 | ✅ | ✅ |
| 后台模式（所有标签页） | — | ✅ |
| 自定义拦截命令 | — | ✅ |
| 可调轮询速度 | — | ✅ |
| 卡住代理恢复 | — | ✅ |
| 多窗口支持 | — | ✅ |
| 智能端口检测 | ✅ | ✅ |

---

## 故障排除

### "无法自动配置" 错误

**症状**：点击 `Auto Accept: OFF` 时，看到：
```
Auto Accept: 无法自动配置。请手动在 Antigravity 快捷方式中添加 --remote-debugging-port=9000，然后重启。
```

**常见原因**：
1. 快捷方式不在标准位置（桌面、开始菜单、任务栏）
2. 没有快捷方式文件的写入权限
3. IDE 以非标准方式安装（便携版、自定义路径）
4. 自定义命名的快捷方式与 IDE 可执行文件不匹配

**手动修复**：

#### Windows
1. 找到你的 IDE 快捷方式（桌面或开始菜单）
2. 右键点击 → **属性**
3. 在 **目标** 字段中，在 `.exe` 路径后添加 `--remote-debugging-port=9000`：
   ```
   "C:\...\Antigravity.exe" --remote-debugging-port=9000
   ```
4. 点击 **确定** 并重启 IDE

#### macOS
请通过终端使用参数启动 IDE：
```bash
# Antigravity
open -a "Antigravity.app" --args --remote-debugging-port=9000

# Cursor
open -a "Cursor.app" --args --remote-debugging-port=9000
```
*提示：您可以在 `.zshrc` 中创建别名：`alias antigravity='open -a "Antigravity" --args --remote-debugging-port=9000'`*

#### Linux
编辑您的 `.desktop` 启动文件（通常在 `/usr/share/applications` 或 `~/.local/share/applications`）：
1. 打开 `.desktop` 文件 (例如 `antigravity.desktop`)
2. 找到 `Exec=` 开头的那一行
3. 在末尾添加 `--remote-debugging-port=9000`
4. 保存并重启应用

---

## 系统要求

- Antigravity 或 Cursor IDE
- 安装后需重启一次

---

## 许可证

MIT