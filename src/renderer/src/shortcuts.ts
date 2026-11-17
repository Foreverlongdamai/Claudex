// 快捷键（M4）：一张表，按键处理和“快捷键”说明窗口都用它。
export interface Shortcut {
  keys: string;
  what: string;
}

export const SHORTCUTS: Array<{ group: string; list: Shortcut[] }> = [
  {
    group: '对话',
    list: [
      { keys: 'Enter', what: '发送' },
      { keys: 'Shift+Enter', what: '换行' },
      { keys: 'Esc', what: '停止 Claude（正在回复时）；关掉弹窗' },
      { keys: 'Shift+Tab', what: '切换模式（默认 → 自动接受编辑 → 计划 → 完全访问 → Skills 配置）' },
      { keys: '/', what: '在输入框开头：命令和 Skills' },
      { keys: '@', what: '引用项目里的文件' },
      { keys: 'Alt+↑ / Alt+↓', what: '切到左栏里上一个 / 下一个对话' }
    ]
  },
  {
    group: '打开',
    list: [
      { keys: 'Ctrl+N', what: '新对话' },
      { keys: 'Ctrl+K', what: '搜索对话' },
      { keys: 'Ctrl+`', what: '内置终端' },
      { keys: 'Ctrl+Shift+D', what: '改动面板（审查和提交）' },
      { keys: 'Ctrl+Shift+B', what: '任务看板' },
      { keys: 'Ctrl+Shift+A', what: '自动化和审查队列' },
      { keys: 'Ctrl+,', what: '设置' },
      { keys: 'Ctrl+/', what: '这张快捷键表' }
    ]
  },
  {
    group: '编辑器',
    list: [
      { keys: 'Ctrl+S', what: '保存 Skill（管理窗口里）' },
      { keys: 'Ctrl+V', what: '终端里粘贴；输入框里粘贴图片' },
      { keys: 'Ctrl+C', what: '终端里选中文字时复制，没选中时中断程序' }
    ]
  }
];
