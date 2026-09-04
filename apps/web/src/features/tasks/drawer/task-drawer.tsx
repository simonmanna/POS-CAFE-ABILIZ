import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Calendar,
  Clock,
  User,
  Building2,
  CheckSquare,
  MessageSquare,
  History,
  Paperclip,
  RotateCcw,
  AlertTriangle,
  MapPin,
  Layers,
  Pencil,
  ShieldCheck,
  Send,
  CircleCheck,
} from 'lucide-react';
import {
  useTask, useUpdateTask, useToggleChecklist, useAddComment, useVerifyTask, useTaskAssignees,
} from '../api';
import {
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  TASK_TYPE_ICONS,
  CATEGORY_LABELS,
} from '../kanban/column-config';
import type { TaskComment } from '../types';
import { TaskStatus } from '../types';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  ASSIGNED: 'bg-blue-100 text-blue-700',
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  WAITING: 'bg-purple-100 text-purple-700',
  REVIEW: 'bg-orange-100 text-orange-700',
  VERIFIED: 'bg-teal-100 text-teal-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-red-100 text-red-700',
  SKIPPED: 'bg-gray-100 text-gray-700',
  OVERDUE: 'bg-red-200 text-red-800',
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  WAITING: 'Waiting',
  REVIEW: 'Review',
  VERIFIED: 'Verified',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  SKIPPED: 'Skipped',
  OVERDUE: 'Overdue',
};

const PRIORITY_LIST = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'OPTIONAL'];
const STATUS_LIST: TaskStatus[] = [
  TaskStatus.DRAFT, TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS,
  TaskStatus.WAITING, TaskStatus.REVIEW, TaskStatus.VERIFIED, TaskStatus.COMPLETED,
  TaskStatus.CANCELLED, TaskStatus.SKIPPED,
];

interface TaskDrawerProps {
  taskId: string | null;
  open: boolean;
  onClose: () => void;
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div>
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="font-medium">{value ?? '-'}</div>
      </div>
    </div>
  );
}

export function TaskDrawer({ taskId, open, onClose }: TaskDrawerProps) {
  const navigate = useNavigate();
  const { data: task, isLoading } = useTask(taskId);
  const { data: assignees = [] } = useTaskAssignees();
  const updateTask = useUpdateTask();
  const toggleChecklist = useToggleChecklist();
  const addComment = useAddComment();
  const verifyTask = useVerifyTask();

  const [comment, setComment] = useState('');
  const [verifyNote, setVerifyNote] = useState('');
  const [showVerify, setShowVerify] = useState(false);

  if (!task) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-lg sm:max-w-xl max-h-[90vh] overflow-y-auto">
          {isLoading ? (
            <div className="space-y-4 p-4">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <div className="flex items-center justify-center h-40 text-muted-foreground">
              Task not found
            </div>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  const patch = (data: Record<string, unknown>) =>
    updateTask.mutate({ id: task.id, ...data });

  const submitComment = async () => {
    if (!comment.trim()) return;
    try {
      await addComment.mutateAsync({ taskId: task.id, content: comment.trim() });
      setComment('');
    } catch {
      // toast surfaced by the caller's error handling; keep the text so it isn't lost
    }
  };

  const doVerify = async () => {
    try {
      await verifyTask.mutateAsync({
        id: task.id,
        verificationMethod: task.verificationMethod ?? 'MANAGER_PIN',
        verificationNote: verifyNote.trim() || undefined,
      });
      setShowVerify(false);
      setVerifyNote('');
    } catch {
      // keep the form open on failure
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg">{TASK_TYPE_ICONS[task.taskType] ?? '📌'}</span>
              <Badge className={`text-xs ${STATUS_COLORS[task.status] ?? ''}`}>
                {STATUS_LABELS[task.status] ?? task.status.replace('_', ' ')}
              </Badge>
              <Badge
                variant="outline"
                className="text-xs"
                style={{
                  backgroundColor: `${PRIORITY_COLORS[task.priority] ?? '#94a3b8'}20`,
                  color: PRIORITY_COLORS[task.priority] ?? '#94a3b8',
                  borderColor: `${PRIORITY_COLORS[task.priority] ?? '#94a3b8'}40`,
                }}
              >
                {PRIORITY_LABELS[task.priority] ?? task.priority}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => {
                onClose();
                navigate(`/tasks/${task.id}/edit`);
              }}
              title="Edit task"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4 p-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : task ? (
          <div className="space-y-6">
            <div>
              <DialogTitle className="text-xl">{task.title}</DialogTitle>
              {task.description && (
                <DialogDescription className="mt-2 whitespace-pre-wrap text-sm">
                  {task.description}
                </DialogDescription>
              )}
            </div>

            {/* ── Quick actions: status / priority / assignee ── */}
            <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
                <Select
                  value={task.status}
                  onValueChange={(value) => patch({ status: value })}
                  disabled={updateTask.isPending}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_LIST.map((s) => (
                      <SelectItem key={s} value={s} className="text-xs">{STATUS_LABELS[s] ?? s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Priority</span>
                <Select
                  value={task.priority}
                  onValueChange={(value) => patch({ priority: value })}
                  disabled={updateTask.isPending}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITY_LIST.map((p) => (
                      <SelectItem key={p} value={p} className="text-xs">{PRIORITY_LABELS[p] ?? p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Assignee</span>
                <Select
                  value={task.assignedToId ?? ''}
                  onValueChange={(value) => patch({ assignedToId: value || null })}
                  disabled={updateTask.isPending}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" className="text-xs">Unassigned</SelectItem>
                    {assignees.map((u) => (
                      <SelectItem key={u.id} value={u.id} className="text-xs">{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3">
              <InfoRow icon={<User className="h-4 w-4" />} label="Assigned To" value={task.assignedTo ? `${task.assignedTo.firstName} ${task.assignedTo.lastName ?? ''}`.trim() : 'Unassigned'} />
              <InfoRow icon={<User className="h-4 w-4" />} label="Supervisor" value={task.supervisor ? `${task.supervisor.firstName} ${task.supervisor.lastName ?? ''}`.trim() : 'None'} />
              <InfoRow icon={<Building2 className="h-4 w-4" />} label="Branch" value={task.branch?.name ?? '-'} />
              <InfoRow icon={<MapPin className="h-4 w-4" />} label="Area" value={task.area ?? '-'} />
              <InfoRow icon={<Layers className="h-4 w-4" />} label="Category" value={task.category ? CATEGORY_LABELS[task.category] ?? task.category : '-'} />
              <InfoRow icon={<Calendar className="h-4 w-4" />} label="Due Date" value={task.dueDate ? `${new Date(task.dueDate).toLocaleDateString()}${task.dueTime ? ` ${task.dueTime}` : ''}` : '-'} />
              <InfoRow icon={<Clock className="h-4 w-4" />} label="Est. Duration" value={task.estimatedMinutes ? `${task.estimatedMinutes} min` : '-'} />
              {task.actualMinutes && <InfoRow icon={<Clock className="h-4 w-4" />} label="Actual Duration" value={`${task.actualMinutes} min`} />}
              {task.isRecurring && (
                <InfoRow icon={<RotateCcw className="h-4 w-4" />} label="Recurrence" value={task.recurrenceType ?? 'Yes'} />
              )}
            </div>

            <Separator />

            {task.checklistItems && task.checklistItems.length > 0 && (
              <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold mb-2">
                  <CheckSquare className="h-4 w-4" />
                  Checklist ({task.checklistProgress}%)
                </h4>
                <div className="space-y-1">
                  {task.checklistItems.map((item) => (
                    <label key={item.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={item.isCompleted}
                        disabled={toggleChecklist.isPending}
                        onChange={(e) =>
                          toggleChecklist.mutate({
                            taskId: task.id,
                            itemId: item.id,
                            isCompleted: e.target.checked,
                          })
                        }
                        className="h-3.5 w-3.5 rounded border-gray-300"
                      />
                      <span className={item.isCompleted ? 'line-through text-muted-foreground' : ''}>
                        {item.description}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {(task.attachmentUrls?.length > 0 || task.photoUrls?.length > 0) && (
              <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold mb-2">
                  <Paperclip className="h-4 w-4" />
                  Attachments ({task.attachmentUrls.length + task.photoUrls.length})
                </h4>
              </div>
            )}

            <Separator />

            {/* ── Comments + composer ── */}
            <div>
              <h4 className="flex items-center gap-2 text-sm font-semibold mb-2">
                <MessageSquare className="h-4 w-4" />
                Comments {(task.comments?.length ?? 0) > 0 && `(${task.comments!.length})`}
              </h4>
              <div className="flex items-end gap-2 mb-3">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  placeholder="Write a comment…"
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment();
                  }}
                />
                <Button
                  size="sm"
                  onClick={submitComment}
                  disabled={!comment.trim() || addComment.isPending}
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
              {task.comments && task.comments.length > 0 && (
                <div className="space-y-3">
                  {task.comments.map((c) => (
                    <CommentBubble key={c.id} comment={c} />
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {task.activityLog && task.activityLog.length > 0 && (
              <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold mb-2">
                  <History className="h-4 w-4" />
                  Activity
                </h4>
                <div className="space-y-2 text-xs text-muted-foreground">
                  {task.activityLog.slice(0, 10).map((log) => (
                    <div key={log.id} className="flex gap-2">
                      <span className="text-nowrap">
                        {new Date(log.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span>{log.description ?? log.action}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Verification ── */}
            {task.requiresVerification && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                <h4 className="flex items-center gap-2 text-sm font-semibold mb-1 text-amber-700">
                  <AlertTriangle className="h-4 w-4" />
                  Verification Required
                </h4>
                {task.verifiedAt ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-700">
                    <CircleCheck className="h-4 w-4" />
                    Verified on {new Date(task.verifiedAt).toLocaleDateString()}
                    {task.verifiedBy && ` by ${task.verifiedBy.firstName} ${task.verifiedBy.lastName ?? ''}`.trim()}
                  </div>
                ) : showVerify ? (
                  <div className="space-y-2 mt-2">
                    <Input
                      value={verifyNote}
                      onChange={(e) => setVerifyNote(e.target.value)}
                      placeholder="Verification note (optional)"
                      className="text-sm"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={doVerify} disabled={verifyTask.isPending}>
                        <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                        {verifyTask.isPending ? 'Verifying…' : 'Confirm verification'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowVerify(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="mt-1" onClick={() => setShowVerify(true)}>
                    <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                    Mark verified
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            Task not found
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CommentBubble({ comment }: { comment: TaskComment }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground mb-1">
        User · {new Date(comment.createdAt).toLocaleDateString()}
      </div>
      <div className="text-sm">{comment.content}</div>
      {comment.replies && comment.replies.length > 0 && (
        <div className="ml-4 mt-2 space-y-2 border-l-2 pl-3">
          {comment.replies.map((reply) => (
            <CommentBubble key={reply.id} comment={reply} />
          ))}
        </div>
      )}
    </div>
  );
}
