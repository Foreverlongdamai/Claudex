// 托盘：关掉窗口时 Claudex 缩到托盘，在后台运行（自动化要按时跑）。托盘菜单可以打开窗口、打开自动化、退出。
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { iconPixels, toBgra } from './iconArt';

/** 程序画的图标（托盘 16px，按屏幕缩放给 32px 的） */
export function appIcon(size = 32, scaleFactor = 2): NativeImage {
  return nativeImage.createFromBitmap(toBgra(iconPixels(size)), { width: size, height: size, scaleFactor });
}

export interface TrayActions {
  open: () => void;
  automation: () => void;
  quit: () => void;
  /** 托盘提示里显示的状态，比如“2 个自动化在跑” */
  status: () => string;
}

export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(appIcon());
  const refresh = () => {
    tray.setToolTip(`Claudex${actions.status() ? ' · ' + actions.status() : ''}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Claudex', click: actions.open },
      { label: '自动化和审查队列', click: actions.automation },
      { type: 'separator' },
      { label: '退出（自动化不再按时运行）', click: actions.quit }
    ]));
  };
  refresh();
  tray.on('click', actions.open);
  tray.on('mouse-move', refresh);
  return tray;
}
