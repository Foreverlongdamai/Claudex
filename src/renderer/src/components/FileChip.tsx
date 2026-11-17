// 附件小卡片：输入框里（可移除）和消息气泡里（只显示）共用。
import { baseName, fileKind, type FileKind } from '@shared/attachments';
import { Icon } from './Icon';

const ICON: Record<FileKind, Parameters<typeof Icon>[0]['name']> = {
  doc: 'file', sheet: 'file', slides: 'file', pdf: 'file', other: 'file',
  audio: 'audio', video: 'video', image: 'image', folder: 'folder'
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function FileChip({ path, size, isDir, onRemove }: { path: string; size?: number; isDir?: boolean; onRemove?: () => void }) {
  const name = baseName(path);
  const kind = fileKind(name, isDir);
  const ext = kind === 'folder' ? '文件夹' : (/\.([^.]+)$/.exec(name)?.[1] ?? '').toUpperCase();
  return (
    <div className={`file-chip k-${kind}`} title={path} data-testid="file-chip">
      <Icon name={ICON[kind]} size={15} />
      <span className="fc-name">{name}</span>
      {(ext || size !== undefined) && <span className="fc-meta">{[ext, size !== undefined && !isDir ? fmtSize(size) : ''].filter(Boolean).join(' · ')}</span>}
      {onRemove && <button className="fc-x" onClick={onRemove} title="移除"><Icon name="x" size={12} /></button>}
    </div>
  );
}
