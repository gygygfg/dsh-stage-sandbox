#!/usr/bin/env python3
"""
dsh_gui.py —— 用 pywinauto 按**控件名**驱动 DeepSeek Harness 桌面端（UIA 后端）。

存在理由：noVNC 像素坐标漂移 + 抢焦点，点击不可靠；Windows 侧的 UIA 能按
Name / AutomationId / ControlType 精确命中控件（Electron 暴露一层 UIA）。

用法（在旅客机里，用 DSH 自带 Python 运行）：
  python dsh_gui.py dump                       # 连接窗口，导出控件树 + 截图
  python dsh_gui.py click "管理 dsh 命令"      # 按精确名字点一个控件
  python dsh_gui.py click "Install"
  python dsh_gui.py menu 应用 "管理 dsh 命令"  # 先点顶层菜单项，再点它的子项
  python dsh_gui.py keys "^n"                  # 发送按键（如 Ctrl+N）

输出默认写到 Samba 共享（Z: 或 \\host.lan\\Data），便于宿主侧取回。
"""
import argparse
import os
import sys
import time
import traceback

OUT_DIR = os.environ.get("DSH_GUI_OUT", r"\\host.lan\Data")


def out_path(name: str) -> str:
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
    except Exception:
        pass
    return os.path.join(OUT_DIR, name)


def log(msg: str) -> None:
    print(msg, flush=True)
    try:
        with open(out_path("dsh-gui.log"), "a", encoding="utf-8") as fh:
            fh.write(msg + "\n")
    except Exception:
        pass


def connect():
    from pywinauto import Application
    try:
        app = Application(backend="uia").connect(title_re=r".*DeepSeek Harness.*", timeout=15)
        win = app.window(title_re=r".*DeepSeek Harness.*")
        win.wait("visible ready", timeout=15)
        return app, win
    except Exception:
        raise RuntimeError("未找到 DeepSeek Harness 窗口（UIA 连接失败）")


def dump(win) -> None:
    lines = []
    try:
        # 逐控件枚举（比 print_control_identifiers 更可控；后者直接 print 到 stdout）
        lines.append("=== descendants ===")
        for c in win.descendants():
            try:
                lines.append(
                    "name=%r ctype=%s auto=%r rect=%s enabled=%s"
                    % (
                        c.window_text(),
                        c.element_info.control_type,
                        c.element_info.automation_id,
                        c.rectangle(),
                        c.is_enabled(),
                    )
                )
            except Exception:
                continue
    except Exception:
        lines.append(traceback.format_exc())
    text = "\n".join(lines)
    with open(out_path("dsh-gui-tree.txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    log("tree -> dsh-gui-tree.txt (%d bytes)" % len(text))


def screenshot(win, name="dsh-gui-shot.png") -> None:
    try:
        from PIL import ImageGrab

        rect = win.rectangle()
        img = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom))
        img.save(out_path(name))
        log("shot -> " + name)
    except Exception as exc:
        log("screenshot failed: %r" % exc)
        try:
            win.capture_as_image().save(out_path(name))
            log("shot(win) -> " + name)
        except Exception as exc2:
            log("screenshot(win) failed: %r" % exc2)


def find_control(win, name, control_type=None, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for c in win.descendants():
            try:
                if c.window_text() == name:
                    if control_type is None or c.element_info.control_type == control_type:
                        return c
            except Exception:
                continue
        time.sleep(0.4)
    return None


def click_name(win, name, control_type=None) -> bool:
    c = find_control(win, name, control_type)
    if c is None:
        log("NOT FOUND: %r" % name)
        return False
    try:
        c.set_focus()
    except Exception:
        pass
    try:
        c.click_input()
        log("clicked %r" % name)
        return True
    except Exception as exc:
        log("click %r failed: %r" % (name, exc))
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["dump", "click", "menu", "keys"])
    ap.add_argument("args", nargs="*")
    ns = ap.parse_args()

    try:
        app, win = connect()
        win.set_focus()
        time.sleep(0.5)
    except Exception as exc:
        log("connect failed: %r" % exc)
        log(traceback.format_exc())
        return 2

    if ns.action == "dump":
        dump(win)
        screenshot(win)
        return 0

    if ns.action == "click":
        ok = click_name(win, ns.args[0], ns.args[1] if len(ns.args) > 1 else None)
        screenshot(win, "dsh-gui-after-click.png")
        return 0 if ok else 1

    if ns.action == "menu":
        top, item = ns.args[0], ns.args[1]
        if not click_name(win, top):
            return 1
        time.sleep(1.0)
        # 菜单弹出后通常是新的顶层窗口/菜单控件，直接在桌面范围内 find
        from pywinauto import Desktop

        found = None
        for w in Desktop(backend="uia").windows():
            c = find_control(w, item, timeout=3)
            if c is not None:
                found = c
                break
        if found is None:
            log("menu item NOT FOUND: %r" % item)
            screenshot(win, "dsh-gui-after-menu.png")
            return 1
        found.click_input()
        log("clicked menu %r -> %r" % (top, item))
        time.sleep(1.5)
        screenshot(win, "dsh-gui-after-menu.png")
        return 0

    if ns.action == "keys":
        from pywinauto.keyboard import send_keys

        win.set_focus()
        send_keys(ns.args[0])
        time.sleep(1.0)
        screenshot(win, "dsh-gui-after-keys.png")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
