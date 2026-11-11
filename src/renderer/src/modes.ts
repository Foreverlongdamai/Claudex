// 5 个模式在界面上的名字、图标、说明（和原型一致）。
import type { ModeId } from '@shared/types';
import type { IconName } from './components/Icon';

export const MODE_ORDER: ModeId[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'skills'];

export const MODES: Record<ModeId, { label: string; icon: IconName; desc: string; toast: string; group: 'builtin' | 'custom' }> = {
  default: {
    label: '默认：询问', icon: 'shield', group: 'builtin',
    desc: '读文件直接执行；改文件、运行命令前先问你',
    toast: '已切换到「默认：询问」：改文件、运行命令前先问你'
  },
  acceptEdits: {
    label: '自动接受编辑', icon: 'filecheck', group: 'builtin',
    desc: '改文件不再询问，运行命令仍会问',
    toast: '已切换到「自动接受编辑」：改文件不再询问，运行命令仍会问'
  },
  plan: {
    label: '计划模式', icon: 'plan', group: 'builtin',
    desc: '只调研和出方案，不改文件、不运行命令',
    toast: '已切换到「计划模式」：只出方案，不改文件、不运行命令'
  },
  bypassPermissions: {
    label: '完全访问', icon: 'unlock', group: 'builtin',
    desc: '所有操作直接执行，不再询问（高危操作仍会拦截）',
    toast: '已切换到「完全访问」：所有操作直接执行（高危操作仍会拦截）'
  },
  skills: {
    label: 'Skills 配置', icon: 'wrench', group: 'custom',
    desc: '按项目需求挑选 Skills 和工具：盘点已有的、上 GitHub 找新的，你确认后再安装',
    toast: '已切换到「Skills 配置」：按项目需求挑选 Skills 和工具，安装前会让你确认'
  }
};
