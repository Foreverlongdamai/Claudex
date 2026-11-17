// 拖放文件：App 在整个对话区接住拖进来的文件，用自定义事件转发给输入框（或终端）。
export const DROP_EVENT = 'claudex:drop-files';
export const TERM_DROP_EVENT = 'claudex:drop-files-terminal';

export interface DroppedFiles {
  files: File[];
  /** 每个文件是不是文件夹（只有拖放时能知道） */
  dirs: boolean[];
}

export function droppedFiles(dt: DataTransfer): DroppedFiles {
  const files = [...dt.files];
  const entries = [...dt.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.());
  return { files, dirs: files.map((_, i) => !!entries[i]?.isDirectory) };
}
