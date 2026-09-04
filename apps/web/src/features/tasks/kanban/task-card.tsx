import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Clock, MessageSquare, Paperclip, RotateCcw, CheckSquare, ChevronRight, CircleCheck,
} from 'lucide-react';
import type { Task } from '../types';
import { TaskStatus } from '../types';
import {
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  TASK_TYPE_ICONS,
} from './column-config';

/** Next status in the happy-path flow for the quick-advance button. */
const NEXT_STATUS: Partial<Record<TaskStatus, TaskStatus>> = {
  [TaskStatus.DRAFT]: TaskStatus.ASSIGNED,
  [TaskStatus.PENDING]: TaskStatus.ASSIGNED,
  [TaskStatus.ASSIGNED]: TaskStatus.IN_PROGRESS,
  [TaskStatus.IN_PROGRESS]: TaskStatus.REVIEW,
  [TaskStatus.REVIEW]: TaskStatus.COMPLETED,
  [TaskStatus.WAITING]: TaskStatus.IN_PROGRESS,
};

interface TaskCardProps {
  task: Task;
  onClick?: () => void;
  onQuickStatus?: (taskId: string, status: TaskStatus) => void;
  busy?: boolean;
}

/** Two-letter initials for the assignee chip. */
function initials(firstName?: string | null, lastName?: string | null): string {
  const a = (firstName ?? '').trim().charAt(0);
  const b = (lastName ?? '').trim().charAt(0);
  return (a + b).toUpperCase() || '?';
}

export function TaskCard({ task, onClick, onQuickStatus, busy }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const priorityColor = PRIORITY_COLORS[task.priority] ?? '#94a3b8';
  const isDone = task.status === 'COMPLETED' || task.status === 'VERIFIED';
  const isOverdue = task.status !== 'COMPLETED' && task.status !== 'CANCELLED' &&
    task.status !== 'SKIPPED' && task.dueDate && new Date(task.dueDate) < new Date();
  const next = NEXT_STATUS[task.status];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={cn(
        'group relative rounded-lg border bg-card p-3 shadow-sm transition-all hover:shadow-md cursor-pointer',
        isDragging && 'opacity-50 shadow-lg',
        isOverdue && 'border-red-300',
      )}
    >
      {/* Priority strip */}
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg" style={{ backgroundColor: priorityColor }} />

      <div className="space-y-2">
        {/* Row 1: Type icon + Title */}
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-sm">{TASK_TYPE_ICONS[task.taskType] ?? '📌'}</span>
          <h4 className={cn(
            'flex-1 text-sm font-medium leading-tight line-clamp-2',
            isDone && 'line-through text-muted-foreground',
          )}>
            {task.title}
          </h4>
          <Badge
            variant="outline"
            className="shrink-0 text-[10px] px-1.5 py-0 h-5"
            style={{
              backgroundColor: `${priorityColor}15`,
              color: priorityColor,
              borderColor: `${priorityColor}30`,
            }}
          >
            {PRIORITY_LABELS[task.priority] ?? task.priority}
          </Badge>
        </div>

        {/* Row 2: Assignee chip + Due Date */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {task.assignedTo ? (
            <span
              className="flex items-center justify-center h-5 w-5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold"
              title={`${task.assignedTo.firstName} ${task.assignedTo.lastName ?? ''}`.trim()}
            >
              {initials(task.assignedTo.firstName, task.assignedTo.lastName)}
            </span>
          ) : (
            <span className="text-muted-foreground/50">Unassigned</span>
          )}
          {task.dueDate && (
            <span className={cn('flex items-center gap-1', isOverdue && 'text-red-500 font-medium')}>
              <Clock className="h-3 w-3" />
              {new Date(task.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              {task.dueTime && ` ${task.dueTime}`}
            </span>
          )}
        </div>

        {/* Row 3: Labels */}
        {task.labels && task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.labels.slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: label.color }}
                title={label.name}
              />
            ))}
            {task.labels.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{task.labels.length - 3}</span>
            )}
          </div>
        )}

        {/* Row 4: Meta icons */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {task.checklistTotal > 0 && (
            <span className="flex items-center gap-1">
              <CheckSquare className="h-3 w-3" />
              {task.checklistProgress}%
            </span>
          )}
          {task.isRecurring && (
            <span className="flex items-center gap-1">
              <RotateCcw className="h-3 w-3" />
            </span>
          )}
          {task.attachmentUrls && task.attachmentUrls.length > 0 && (
            <span className="flex items-center gap-1">
              <Paperclip className="h-3 w-3" />
              {task.attachmentUrls.length}
            </span>
          )}
          {task.photoUrls && task.photoUrls.length > 0 && (
            <span className="flex items-center gap-1">📷 {task.photoUrls.length}</span>
          )}
          {task.comments && task.comments.length > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              {task.comments.length}
            </span>
          )}
          {task.estimatedMinutes && (
            <span className="flex items-center gap-1">⏱ {task.estimatedMinutes}m</span>
          )}
        </div>

        {/* Progress bar */}
        {task.checklistTotal > 0 && (
          <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${task.checklistProgress}%` }}
            />
          </div>
        )}

        {/* Quick-advance: move to the next status without opening the drawer.
            Stop propagation so the drag/click handlers don't fire. */}
        {next && onQuickStatus && (
          <div
            className="pt-1 border-t border-dashed border-muted opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full text-[11px] text-muted-foreground hover:text-primary"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onQuickStatus(task.id, next);
              }}
              title={`Move to ${next.replace('_', ' ').toLowerCase()}`}
            >
              {next === 'COMPLETED' ? <CircleCheck className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
              {next === 'COMPLETED' ? 'Mark complete' : `Move to ${next.replace('_', ' ').toLowerCase()}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
