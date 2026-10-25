import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Play, HardDrive, Clock, Plus, X, Loader2, Database, FolderOpen, Shield, Bell, Trash2, Globe, Tag, Settings2, ShieldCheck, AlertTriangle, CheckCircle2, History } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { apiMessage, notify } from '@/lib/notify';
import { tx } from '@/lib/i18n/tx';

// =============================================================================
// Types
// =============================================================================

type BackupFrequency = 'manual' | 'every_hour' | 'every_2_hours' | 'every_4_hours' | 'every_6_hours' | 'every_12_hours' | 'daily' | 'weekly' | 'monthly' | 'custom_minutes' | 'custom_hours' | 'cron';
type BackupType = 'full' | 'incremental' | 'differential' | 'snapshot' | 'mirror';
type CompressionLevel = 0 | 1 | 6 | 9;
type EncryptionType = 'none' | 'aes256';
type DestinationType = 'local' | 'external_drive' | 'network_folder' | 'onedrive' | 'google_drive' | 'dropbox' | 's3' | 'azure' | 'ftp' | 'sftp';
type RetentionMode = 'keep_last' | 'keep_by_age' | 'smart';
type InternetBehaviour = 'local_only' | 'upload_immediately' | 'upload_when_internet_returns';
type BackupKind = 'full' | 'incremental' | 'differential' | 'files' | 'config' | 'cleanup' | 'restore_test';

type BackupIncludes = Record<string, boolean>;

interface BackupDestination {
  type: DestinationType; path: string; label?: string; enabled?: boolean;
  accessKey?: string; secretKey?: string; region?: string; bucket?: string;
}

interface RetentionPolicy { mode: RetentionMode; keepLastCount?: number; keepDays?: number; smartDaily?: number; smartWeekly?: number; smartMonthly?: number; }
interface NotificationsConfig { on: string[]; channels: string[]; emailAddress?: string; phoneNumber?: string; }
interface VerificationConfig { verifyIntegrity: boolean; testRestore: boolean; sha256Checksum: boolean; }
interface EncryptionConfig { type: EncryptionType; password?: string; }
interface CleanupConfig { deleteExpired: boolean; deleteTempFiles: boolean; removeFailedFiles: boolean; }
interface ScheduleConfig { time?: string; dayOfWeek?: number; timezone?: string; customIntervalMinutes?: number; cronExpression?: string; }
interface AdvancedConfig {
  maxThreads: number; compressionLevel: number; pauseBusinessHours: boolean; businessHoursStart: string; businessHoursEnd: string;
  skipIfBusy: boolean; retryCount: number; retryDelayMinutes: number; backupTimeoutMinutes: number; maxDiskUsageGb: number; autoDiskSpaceCheck: boolean;
}

interface BackupConfig {
  frequency: BackupFrequency; dailyConfig?: { times: string[] }; weeklyConfig?: { days: number[]; time: string };
  customCronExpression?: string; customIntervalMinutes?: number;
  types: BackupType[]; includes: BackupIncludes; destinations: BackupDestination[];
  retention: RetentionPolicy; compression: CompressionLevel; encryption: EncryptionConfig;
  verification: VerificationConfig; notifications: NotificationsConfig; cleanup: CleanupConfig;
  internetBehaviour: InternetBehaviour; namingFormat?: string; schedule?: ScheduleConfig; advanced: AdvancedConfig;
}

interface BackupRunResult {
  kind: BackupKind; status: 'success' | 'failed' | 'skipped'; target?: string; sizeBytes?: number; durationMs: number; finishedAt: string;
  error?: string; checksumSha256?: string; encrypted?: boolean; database?: string; warnings?: string[];
  copies?: { destination: string; ok: boolean; error?: string }[];
}
interface BackupStatus {
  lastByKind: Partial<Record<BackupKind, BackupRunResult>>; recent: BackupRunResult[]; config: BackupConfig;
  server?: { primaryDir: string; schedulerEnabled: boolean; encryptionActive: boolean; encryptionEnforcedByEnv: boolean; scheduleError?: string };
}
interface BackupHealth { status: 'healthy' | 'degraded' | 'critical'; issues: string[]; checkedAt: string; }
interface BackupItem { file: string; name: string; size: number; mtime: string; kind: string; encrypted: boolean; }
interface RestoreResult { success: boolean; message: string; error?: string; }

// =============================================================================
// Helpers
// =============================================================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQ_LABELS: Record<BackupFrequency, string> = { manual: 'Manual Only', every_hour: 'Every Hour', every_2_hours: 'Every 2 Hours', every_4_hours: 'Every 4 Hours', every_6_hours: 'Every 6 Hours', every_12_hours: 'Every 12 Hours', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', custom_minutes: 'Every X Minutes', custom_hours: 'Every X Hours', cron: 'Cron Expression (Advanced)' };
const KIND_LABELS: Partial<Record<BackupKind, string>> = { full: 'Database', files: 'Images', config: 'Config', incremental: 'WAL', restore_test: 'Restore test' };
const CLOUD: DestinationType[] = ['onedrive', 'google_drive', 'dropbox', 's3', 'azure', 'ftp', 'sftp'];
const MASK = '********';

function fmtTime(iso: string) { return new Date(iso).toLocaleString(); }
function fmtSize(b?: number) { if (!b) return '\u2014'; if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`; if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`; return `${(b / 1073741824).toFixed(2)} GB`; }
function fmtDuration(ms: number) { const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; return `${Math.floor(s / 60)}m ${s % 60}s`; }

function Checkbox({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-70' : 'cursor-pointer'}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />{label}</label>;
}

function Section({ title, icon: Icon, desc, children }: { title: string; icon: any; desc?: string; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Icon className="h-4 w-4" />{title}</CardTitle>{desc && <CardDescription>{desc}</CardDescription>}</CardHeader><CardContent className="space-y-3">{children}</CardContent></Card>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** Field labels per destination type — the backend reuses path/accessKey/secretKey/bucket/region. */
function destFields(t: DestinationType): { path: string; pathHint?: string; bucket?: string; region?: boolean; access?: string; secret?: string } {
  switch (t) {
    case 'local': return { path: 'Folder', pathHint: 'e.g. D:\\POS-BACKUPS. The first local folder is the main backup folder.' };
    case 'external_drive': return { path: 'Folder on the drive', pathHint: 'e.g. E:\\POS-BACKUPS. Copies fail (and show here) while the drive is unplugged.' };
    case 'network_folder': return { path: 'Network folder', pathHint: 'e.g. \\\\NAS\\backups\\pos. The API service account needs write access.' };
    case 's3': return { path: 'Folder (prefix)', bucket: 'Bucket', region: true, access: 'Access key ID', secret: 'Secret access key', pathHint: 'Needs the AWS CLI on the server.' };
    case 'azure': return { path: 'Folder (prefix)', bucket: 'Container', access: 'Storage account', secret: 'Account key', pathHint: 'Needs the Azure CLI on the server.' };
    case 'google_drive': case 'dropbox': case 'onedrive': return { path: 'Folder', bucket: 'rclone remote name', pathHint: 'Needs rclone on the server, set up once with `rclone config`.' };
    case 'sftp': return { path: 'host:/remote/folder', access: 'User', pathHint: 'Uses scp with an SSH key for the API service account (no passwords).' };
    case 'ftp': return { path: 'host/folder', access: 'User', secret: 'Password', pathHint: 'Plain FTP sends the password unencrypted; prefer SFTP or a cloud destination.' };
  }
}

/**
 * Runs a backup job. The request "succeeds" over HTTP even when the backup
 * failed, so the toast is driven by the returned result. No client timeout:
 * a restore test of a large database takes minutes.
 */
function useBackupRun(url: string, label: string, onDone: () => void) {
  return useMutation({
    mutationFn: async (body?: object) => (await api.post<BackupRunResult>(url, body ?? {}, { timeout: 0 })).data,
    onSuccess: (r: BackupRunResult) => {
      if (r.status === 'failed') notify.error(`${label} failed`, r.error);
      else if (r.status === 'skipped') notify.warning(`${label} skipped`, r.error);
      else if (r.warnings?.length && r.kind !== 'restore_test') notify.warning(`${label} done, with warnings`, r.warnings.join('; '));
      else notify.success(`${label} done`, r.kind === 'restore_test' ? r.warnings?.[0] : undefined);
      onDone();
    },
    onError: (e) => notify.error(`${label} failed`, apiMessage(e, 'Request failed')),
  });
}

// =============================================================================
// Page Component
// =============================================================================

export function BackupPage() {
  const qc = useQueryClient();

  const [freq, setFreq] = useState<BackupFrequency>('daily');
  const [dailyTimes, setDailyTimes] = useState<string[]>(['02:00']);
  const [weeklyDays, setWeeklyDays] = useState<number[]>([0]);
  const [weeklyTime, setWeeklyTime] = useState('03:00');
  const [customInterval, setCustomInterval] = useState(60);
  const [customCron, setCustomCron] = useState('');
  const [types, setTypes] = useState<BackupType[]>(['full']);
  const [includes, setIncludes] = useState<BackupIncludes>({});
  const [destinations, setDestinations] = useState<BackupDestination[]>([]);
  const [retentionMode, setRetentionMode] = useState<RetentionMode>('keep_last');
  const [keepLast, setKeepLast] = useState(14);
  const [keepDays, setKeepDays] = useState(30);
  const [smartDaily, setSmartDaily] = useState(14);
  const [smartWeekly, setSmartWeekly] = useState(8);
  const [smartMonthly, setSmartMonthly] = useState(12);
  const [compression, setCompression] = useState<CompressionLevel>(6);
  const [encryptType, setEncryptType] = useState<EncryptionType>('none');
  const [encryptPwd, setEncryptPwd] = useState('');
  const [testRestore, setTestRestore] = useState(true);
  const [notifyOn, setNotifyOn] = useState<string[]>(['failed']);
  const [notifyChannels, setNotifyChannels] = useState<string[]>(['desktop']);
  const [notifyEmail, setNotifyEmail] = useState('');
  const [internetMode, setInternetMode] = useState<InternetBehaviour>('local_only');
  const [namingFmt, setNamingFmt] = useState('POS-CAFE_{TYPE}_{DATE}_{TIME}');
  const [autoCleanup, setAutoCleanup] = useState(true);
  const [advanced, setAdvanced] = useState<AdvancedConfig | null>(null);
  const [advRetry, setAdvRetry] = useState(2);
  const [advRetryDelay, setAdvRetryDelay] = useState(5);
  const [advTimeout, setAdvTimeout] = useState(60);

  const status = useQuery<BackupStatus>({ queryKey: ['backup-status'], queryFn: async () => (await api.get<BackupStatus>('/admin/backups/status')).data });
  const health = useQuery<BackupHealth>({ queryKey: ['backup-health'], queryFn: async () => (await api.get<BackupHealth>('/admin/backups/health')).data });
  const list = useQuery<BackupItem[]>({ queryKey: ['backup-list'], queryFn: async () => (await api.get<BackupItem[]>('/admin/backups/list', { params: { kind: 'full' } })).data });

  const initForm = (cfg: BackupConfig) => {
    setFreq(cfg.frequency);
    setDailyTimes(cfg.dailyConfig?.times ?? ['02:00']);
    setWeeklyDays(cfg.weeklyConfig?.days ?? [0]);
    setWeeklyTime(cfg.weeklyConfig?.time ?? '03:00');
    setCustomInterval(cfg.customIntervalMinutes ?? 60);
    setCustomCron(cfg.customCronExpression ?? '');
    setTypes(cfg.types.includes('full') ? cfg.types : ['full', ...cfg.types]);
    setIncludes(cfg.includes ?? {});
    setDestinations(cfg.destinations);
    setRetentionMode(cfg.retention.mode);
    setKeepLast(cfg.retention.keepLastCount ?? 14);
    setKeepDays(cfg.retention.keepDays ?? 30);
    setSmartDaily(cfg.retention.smartDaily ?? 14);
    setSmartWeekly(cfg.retention.smartWeekly ?? 8);
    setSmartMonthly(cfg.retention.smartMonthly ?? 12);
    setCompression((cfg.advanced?.compressionLevel ?? cfg.compression) as CompressionLevel);
    setEncryptType(cfg.encryption.type);
    setEncryptPwd(cfg.encryption.password ?? '');
    setTestRestore(cfg.verification.testRestore);
    setNotifyOn(cfg.notifications.on);
    setNotifyChannels(cfg.notifications.channels);
    setNotifyEmail(cfg.notifications.emailAddress ?? '');
    setInternetMode(cfg.internetBehaviour);
    setNamingFmt(cfg.namingFormat ?? 'POS-CAFE_{TYPE}_{DATE}_{TIME}');
    setAutoCleanup(cfg.cleanup.deleteExpired);
    setAdvanced(cfg.advanced);
    setAdvRetry(cfg.advanced.retryCount);
    setAdvRetryDelay(cfg.advanced.retryDelayMinutes);
    setAdvTimeout(cfg.advanced.backupTimeoutMinutes);
  };

  useEffect(() => { if (status.data) initForm(status.data.config); }, [status.data]);

  const buildPayload = (): BackupConfig => ({
    frequency: freq, types,
    dailyConfig: { times: dailyTimes },
    weeklyConfig: { days: weeklyDays, time: weeklyTime },
    customCronExpression: customCron,
    customIntervalMinutes: customInterval,
    includes,
    destinations,
    retention: { mode: retentionMode, keepLastCount: keepLast, keepDays, smartDaily, smartWeekly, smartMonthly },
    compression,
    encryption: { type: encryptType, password: encryptType === 'aes256' ? encryptPwd : '' },
    verification: { verifyIntegrity: true, testRestore, sha256Checksum: true },
    notifications: { on: notifyOn, channels: notifyChannels, emailAddress: notifyEmail, phoneNumber: '' },
    cleanup: { deleteExpired: autoCleanup, deleteTempFiles: true, removeFailedFiles: true },
    internetBehaviour: internetMode,
    namingFormat: namingFmt,
    schedule: { time: dailyTimes[0] ?? '02:00', dayOfWeek: 7, timezone: 'UTC', customIntervalMinutes: customInterval, cronExpression: customCron },
    advanced: { ...(advanced as AdvancedConfig), compressionLevel: compression, retryCount: advRetry, retryDelayMinutes: advRetryDelay, backupTimeoutMinutes: advTimeout },
  });

  const refresh = () => ['backup-status', 'backup-health', 'backup-list'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const save = useMutation({
    mutationFn: async () => (await api.put('/admin/backups/settings', buildPayload())).data,
    onSuccess: () => { notify.success(tx('Backup settings saved')); refresh(); },
    onError: (e) => notify.error(tx('Settings not saved'), apiMessage(e, 'Failed')),
  });

  const runFull = useBackupRun('/admin/backups/full', 'Database backup', refresh);
  const runInc = useBackupRun('/admin/backups/incremental', 'WAL switch', refresh);
  const runFiles = useBackupRun('/admin/backups/files', 'Image backup', refresh);
  const runConfig = useBackupRun('/admin/backups/config', 'Config backup', refresh);
  const runTest = useBackupRun('/admin/backups/restore/test', 'Restore test', refresh);

  const verify = useMutation({
    mutationFn: async (backupFile: string) => (await api.post<RestoreResult>('/admin/backups/restore/verify', { backupFile }, { timeout: 0 })).data,
    onSuccess: (r) => (r.success ? notify.success(tx('Backup verified'), r.message) : notify.error(tx('Verification failed'), r.error ?? r.message)),
    onError: (e) => notify.error(tx('Verification failed'), apiMessage(e, 'Request failed')),
  });

  const addDest = (type: DestinationType = 'external_drive') => setDestinations([...destinations, { type, path: '', label: '', enabled: true }]);
  const updDest = (i: number, p: Partial<BackupDestination>) => { const d = [...destinations]; d[i] = { ...d[i], ...p }; setDestinations(d); };
  const rmDest = (i: number) => setDestinations(destinations.filter((_, idx) => idx !== i));

  const toggleArr = (arr: string[], v: string) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  const setIncludePair = (keys: string[], v: boolean) => setIncludes({ ...includes, ...Object.fromEntries(keys.map((k) => [k, v])) });

  const lastByKind = status.data?.lastByKind;
  const server = status.data?.server;
  const busy = runFull.isPending || runTest.isPending;
  const primaryIndex = destinations.findIndex((d) => d.type === 'local' && d.enabled !== false && d.path?.trim());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold">{tx('Backup')}</h1><Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{tx('Save All Settings')}</Button></div>

      {/* Health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {health.data?.status === 'healthy' ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertTriangle className={`h-4 w-4 ${health.data?.status === 'critical' ? 'text-destructive' : 'text-amber-500'}`} />}
            {tx('Backup health')}
            {health.data && <Badge variant={health.data.status === 'healthy' ? 'default' : health.data.status === 'critical' ? 'destructive' : 'secondary'} className="capitalize">{health.data.status}</Badge>}
          </CardTitle>
          {server && <CardDescription>{tx('Main backup folder:')} <code>{server.primaryDir}</code></CardDescription>}
        </CardHeader>
        <CardContent>
          {health.isLoading ? <Skeleton className="h-10 w-full" /> : health.data?.issues.length ? (
            <ul className="space-y-1 text-sm">{health.data.issues.map((i) => <li key={i} className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" /><span>{i}</span></li>)}</ul>
          ) : <p className="text-sm text-muted-foreground">{tx('Backups are running, encrypted, copied to a second place and restore-tested.')}</p>}
        </CardContent>
      </Card>

      <Tabs defaultValue="schedule">
        <TabsList className="flex-wrap">
          <TabsTrigger value="schedule">{tx('Schedule')}</TabsTrigger>
          <TabsTrigger value="content">{tx('Content')}</TabsTrigger>
          <TabsTrigger value="storage">{tx('Storage')}</TabsTrigger>
          <TabsTrigger value="retention">{tx('Retention')}</TabsTrigger>
          <TabsTrigger value="security">{tx('Security')}</TabsTrigger>
          <TabsTrigger value="notifications">{tx('Notifications')}</TabsTrigger>
          <TabsTrigger value="advanced">{tx('Advanced')}</TabsTrigger>
        </TabsList>

        {/* ===================================================================== */}
        {/* TAB: Schedule */}
        {/* ===================================================================== */}
        <TabsContent value="schedule" className="space-y-4 mt-4">
          <Section title={tx('Backup Frequency')} icon={Clock} desc="How often should backups run?">
            <Select value={freq} onValueChange={(v: BackupFrequency) => setFreq(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(FREQ_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
            {freq === 'daily' && (
              <div>
                <Label>{tx('Backup times')}</Label>
                {dailyTimes.map((t, i) => (<div key={i} className="flex items-center gap-2 mt-1"><Input type="time" value={t} onChange={(e) => { const d = [...dailyTimes]; d[i] = e.target.value; setDailyTimes(d); }} className="w-32" />{dailyTimes.length > 1 && <Button size="icon" variant="ghost" onClick={() => setDailyTimes(dailyTimes.filter((_, idx) => idx !== i))}><X className="h-3 w-3" /></Button>}</div>))}
                <Button size="sm" variant="outline" onClick={() => setDailyTimes([...dailyTimes, '12:00'])} className="mt-1"><Plus className="h-3 w-3 mr-1" />{tx('Add time')}</Button>
              </div>
            )}
            {freq === 'weekly' && (
              <div className="grid grid-cols-2 gap-2">
                <div><Label>{tx('Days')}</Label>{[0, 1, 2, 3, 4, 5, 6].map((d) => <Checkbox key={d} label={DAY_NAMES[d]} checked={weeklyDays.includes(d)} onChange={(v) => setWeeklyDays(v ? [...weeklyDays, d] : weeklyDays.filter((x) => x !== d))} />)}</div>
                <div><Label>{tx('Time')}</Label><Input type="time" value={weeklyTime} onChange={(e) => setWeeklyTime(e.target.value)} /></div>
              </div>
            )}
            {freq === 'custom_minutes' && <div><Label>{tx('Every X minutes (1–59)')}</Label><Input type="number" min={1} max={59} value={customInterval} onChange={(e) => setCustomInterval(Number(e.target.value))} /></div>}
            {freq === 'custom_hours' && <div><Label>{tx('Every X hours (1–23)')}</Label><Input type="number" min={1} max={23} value={customInterval} onChange={(e) => setCustomInterval(Number(e.target.value))} /></div>}
            {freq === 'cron' && <div><Label>{tx('Cron Expression')}</Label><Input value={customCron} onChange={(e) => setCustomCron(e.target.value)} placeholder={'0 2 * * *'} /><Hint>{tx('Standard cron format: minute hour day month weekday')}</Hint></div>}
            {freq === 'monthly' && <Hint>{tx('Runs on the 1st of every month at 02:00')}</Hint>}
            {freq === 'manual' && <Hint>{tx('Nothing runs automatically. Not recommended for a live café.')}</Hint>}
            {freq !== 'manual' && <Hint>{tx('If the server is switched off at backup time, a catch-up backup runs a few minutes after it starts again.')}</Hint>}
            {server && !server.schedulerEnabled && <p className="text-sm text-destructive">{tx('Automatic backups are switched off on this server (BACKUP_CRON_ENABLED=false).')}</p>}
          </Section>

          <Section title={tx('Backup Type')} icon={Database} desc="What kind of backups to create">
            <div className="space-y-1">
              <Checkbox label={tx('Full database backup (always on)')} checked disabled onChange={() => undefined} />
              <Checkbox label={tx('WAL segment switch (only with WAL archiving set up on PostgreSQL)')} checked={types.includes('incremental')} onChange={() => setTypes(toggleArr(types, 'incremental') as BackupType[])} />
              <Hint>{tx('Point-in-time recovery needs archive_mode on the PostgreSQL server; see docs/backup-recovery.md. Without it, this option is skipped.')}</Hint>
            </div>
          </Section>

          <Section title={tx('Run Now')} icon={Play} desc="Trigger a backup immediately">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => runFull.mutate(undefined)} disabled={busy}>{runFull.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('Database Backup')}</Button>
              <Button variant="outline" onClick={() => runFiles.mutate(undefined)} disabled={runFiles.isPending}>{runFiles.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('Images')}</Button>
              <Button variant="outline" onClick={() => runConfig.mutate(undefined)} disabled={runConfig.isPending}>{runConfig.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('Server Config')}</Button>
              <Button variant="outline" onClick={() => runTest.mutate(undefined)} disabled={busy}>{runTest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}<ShieldCheck className="mr-2 h-4 w-4" />{tx('Test Restore (latest)')}</Button>
              {types.includes('incremental') && <Button variant="outline" onClick={() => runInc.mutate(undefined)} disabled={runInc.isPending}>{runInc.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('WAL Switch')}</Button>}
            </div>
          </Section>
        </TabsContent>

        {/* ===================================================================== */}
        {/* TAB: Content */}
        {/* ===================================================================== */}
        <TabsContent value="content" className="space-y-4 mt-4">
          <Section title={tx('What is backed up')} icon={FolderOpen} desc="Each item is a separate backup run on the same schedule">
            <Checkbox label={tx('Database: all sales, stock, accounts, settings, printers, receipts (always)')} checked disabled onChange={() => undefined} />
            <Checkbox label={tx('Uploaded images (product photos, documents)')} checked={!!(includes.uploadedImages || includes.productImages)} onChange={(v) => setIncludePair(['uploadedImages', 'productImages'], v)} />
            <Checkbox label={tx('Server configuration (.env): needed to rebuild the server')} checked={!!(includes.envFile || includes.configFiles)} onChange={(v) => setIncludePair(['envFile', 'configFiles'], v)} />
            <Hint>{tx('The configuration backup holds server secrets. It is encrypted when backup encryption is on; the encryption password itself is never written into it.')}</Hint>
          </Section>
        </TabsContent>

        {/* ===================================================================== */}
        {/* TAB: Storage */}
        {/* ===================================================================== */}
        <TabsContent value="storage" className="space-y-4 mt-4">
          <Section title={tx('Backup Destinations')} icon={HardDrive} desc="The first local folder is the main backup folder; every other destination receives a verified copy">
            {destinations.map((d, i) => {
              const f = destFields(d.type);
              return (
                <div key={i} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{tx('Destination #')}{i + 1}{i === primaryIndex && <Badge variant="secondary" className="ml-2">{tx('Main folder')}</Badge>}</span>
                    <Button size="icon" variant="ghost" onClick={() => rmDest(i)}><X className="h-3 w-3" /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label>{tx('Type')}</Label>
                      <Select value={d.type} onValueChange={(v: DestinationType) => updDest(i, { type: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="local">{tx('Local Folder')}</SelectItem>
                          <SelectItem value="external_drive">{tx('External / USB Drive')}</SelectItem>
                          <SelectItem value="network_folder">{tx('Network Folder (NAS)')}</SelectItem>
                          <SelectItem value="onedrive">{tx('OneDrive (rclone)')}</SelectItem>
                          <SelectItem value="google_drive">{tx('Google Drive (rclone)')}</SelectItem>
                          <SelectItem value="dropbox">{tx('Dropbox (rclone)')}</SelectItem>
                          <SelectItem value="s3">{tx('Amazon S3')}</SelectItem>
                          <SelectItem value="azure">{tx('Azure Blob Storage')}</SelectItem>
                          <SelectItem value="sftp">SFTP</SelectItem>
                          <SelectItem value="ftp">FTP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div><Label>{f.path}</Label><Input value={d.path} onChange={(e) => updDest(i, { path: e.target.value })} /></div>
                  </div>
                  {f.pathHint && <Hint>{f.pathHint}</Hint>}
                  {(f.bucket || f.region || f.access || f.secret) && (
                    <div className="grid grid-cols-2 gap-2">
                      {f.bucket && <div><Label>{f.bucket}</Label><Input value={d.bucket ?? ''} onChange={(e) => updDest(i, { bucket: e.target.value })} /></div>}
                      {f.region && <div><Label>{tx('Region')}</Label><Input value={d.region ?? ''} placeholder={tx('us-east-1')} onChange={(e) => updDest(i, { region: e.target.value })} /></div>}
                      {f.access && <div><Label>{f.access}</Label><Input value={d.accessKey ?? ''} autoComplete="off" onChange={(e) => updDest(i, { accessKey: e.target.value })} /></div>}
                      {f.secret && <div><Label>{f.secret}</Label><Input type="password" value={d.secretKey ?? ''} autoComplete="new-password" onFocus={() => d.secretKey === MASK && updDest(i, { secretKey: '' })} onChange={(e) => updDest(i, { secretKey: e.target.value })} /></div>}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label>{tx('Label')}</Label><Input value={d.label ?? ''} onChange={(e) => updDest(i, { label: e.target.value })} /></div>
                    <div className="flex items-end pb-2"><Checkbox label={tx('Enabled')} checked={d.enabled ?? true} onChange={(v) => updDest(i, { enabled: v })} /></div>
                  </div>
                </div>
              );
            })}
            {primaryIndex < 0 && <p className="text-sm text-destructive">{tx('Add an enabled Local Folder: it is where backups are written first.')}</p>}
            {destinations.length < 2 && <Hint>{tx('Add a second destination (a USB drive that leaves the building, a NAS, or cloud storage). A backup on the same disk as the database is lost together with it.')}</Hint>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => addDest('external_drive')}><Plus className="h-3 w-3 mr-1" />{tx('USB / External Drive')}</Button>
              <Button size="sm" variant="outline" onClick={() => addDest('network_folder')}><Plus className="h-3 w-3 mr-1" />{tx('Network Folder')}</Button>
              <Button size="sm" variant="outline" onClick={() => addDest('s3')}><Plus className="h-3 w-3 mr-1" />{tx('Cloud')}</Button>
            </div>
          </Section>

          <Section title={tx('Internet Behaviour')} icon={Globe} desc="Applies to cloud destinations only; drives and network folders are always copied">
            <Select value={internetMode} onValueChange={(v: InternetBehaviour) => setInternetMode(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="local_only">{tx('Do not upload to the cloud')}</SelectItem>
                <SelectItem value="upload_immediately">{tx('Upload right after each backup')}</SelectItem>
                <SelectItem value="upload_when_internet_returns">{tx('Upload right after each backup (retried on the next run)')}</SelectItem>
              </SelectContent>
            </Select>
            {internetMode === 'local_only' && destinations.some((d) => CLOUD.includes(d.type) && d.enabled !== false) && <p className="text-sm text-amber-600">{tx('Cloud destinations are configured but uploads are off.')}</p>}
          </Section>

          <Section title={tx('Backup Naming')} icon={Tag} desc="How backup files are named">
            <Input value={namingFmt} onChange={(e) => setNamingFmt(e.target.value)} />
            <Hint>{tx('Available tokens:')} <code>{'{TYPE}'}</code>, <code>{'{DATE}'}</code>, <code>{'{TIME}'}</code></Hint>
            <Hint>{tx('Example:')} {namingFmt.replace('{TYPE}', 'FULL').replace('{DATE}', '2026-07-20').replace('{TIME}', '020000')}{tx('.dump')}{server?.encryptionActive ? '.enc' : ''}</Hint>
          </Section>
        </TabsContent>

        {/* ===================================================================== */}
        {/* TAB: Retention */}
        {/* ===================================================================== */}
        <TabsContent value="retention" className="space-y-4 mt-4">
          <Section title={tx('Retention Policy')} icon={Trash2} desc="How long to keep backups (applied to every folder destination)">
            <Select value={retentionMode} onValueChange={(v: RetentionMode) => setRetentionMode(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="keep_last">{tx('Keep Last N Backups')}</SelectItem>
                <SelectItem value="keep_by_age">{tx('Delete After N Days')}</SelectItem>
                <SelectItem value="smart">{tx('Smart (daily, weekly, monthly)')}</SelectItem>
              </SelectContent>
            </Select>
            {retentionMode === 'keep_last' && <div><Label>{tx('Keep last')}</Label><Input type="number" min={1} value={keepLast} onChange={(e) => setKeepLast(Number(e.target.value))} /></div>}
            {retentionMode === 'keep_by_age' && <div><Label>{tx('Delete after (days)')}</Label><Input type="number" min={1} value={keepDays} onChange={(e) => setKeepDays(Number(e.target.value))} /></div>}
            {retentionMode === 'smart' && (
              <div className="grid grid-cols-3 gap-2">
                <div><Label>{tx('Daily (days)')}</Label><Input type="number" min={1} value={smartDaily} onChange={(e) => setSmartDaily(Number(e.target.value))} /></div>
                <div><Label>{tx('Weekly (weeks)')}</Label><Input type="number" min={1} value={smartWeekly} onChange={(e) => setSmartWeekly(Number(e.target.value))} /></div>
                <div><Label>{tx('Monthly (months)')}</Label><Input type="number" min={1} value={smartMonthly} onChange={(e) => setSmartMonthly(Number(e.target.value))} /></div>
              </div>
            )}
            <Hint>{tx('The 3 newest backups are always kept, so a run of failed nights never deletes the last good ones. The image folder is a mirror and is never pruned.')}</Hint>
          </Section>

          <Section title={tx('Automatic Cleanup')} icon={Trash2} desc="Runs daily at 05:00">
            <Checkbox label={tx('Delete backups outside the retention policy')} checked={autoCleanup} onChange={setAutoCleanup} />
          </Section>
        </TabsContent>

        {/* ===================================================================== */}
        {/* TAB: Security */}
        {/* ===================================================================== */}
        <TabsContent value="security" className="space-y-4 mt-4">
          <Section title={tx('Encryption')} icon={Shield} desc="A backup is a full copy of every sale, customer and account">
            {server?.encryptionEnforcedByEnv ? (
              <p className="text-sm">{tx('Encryption is')} <b>on</b>: the server&apos;s BACKUP_ENCRYPTION_PASSWORD is used for every backup.</p>
            ) : (
              <>
                <Select value={encryptType} onValueChange={(v: EncryptionType) => setEncryptType(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{tx('None (not recommended)')}</SelectItem>
                    <SelectItem value="aes256">{tx('AES-256 Password Encryption')}</SelectItem>
                  </SelectContent>
                </Select>
                {encryptType === 'aes256' && <div><Label>{tx('Backup Password')}</Label><Input type="password" value={encryptPwd} autoComplete="new-password" onFocus={() => encryptPwd === MASK && setEncryptPwd('')} onChange={(e) => setEncryptPwd(e.target.value)} placeholder={tx('Enter encryption password')} /></div>}
              </>
            )}
            <Hint>{tx('Write the password down and keep it away from the server and the backup drive. Without it no backup can be restored. Changing it only affects new backups.')}</Hint>
          </Section>

          <Section title={tx('Compression')} icon={HardDrive} desc="Backup file compression level">
            <Select value={String(compression)} onValueChange={(v) => setCompression(Number(v) as CompressionLevel)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{tx('None')}</SelectItem>
                <SelectItem value="1">{tx('Fast Compression')}</SelectItem>
                <SelectItem value="6">{tx('Normal Compression')}</SelectItem>
                <SelectItem value="9">{tx('Maximum Compression')}</SelectItem>
              </SelectContent>
            </Select>
          </Section>

          <Section title={tx('Verification')} icon={ShieldCheck} desc="Every backup is read back and checksummed; copies are re-checked after copying">
            <Checkbox label={tx('Test-restore every scheduled backup into a temporary database (then delete it)')} checked={testRestore} onChange={setTestRestore} />
          </Section>
        </TabsContent>

        {/* ===================================================================== */}
        {/* TAB: Notifications */}
        {/* ===================================================================== */}
        <TabsContent value="notifications" className="space-y-4 mt-4">
          <Section title={tx('Notifications')} icon={Bell} desc="Get notified about backup events">
            <div><Label>{tx('Notify when')}</Label>{[['failed', 'A backup or copy fails'], ['completed', 'A backup completes'], ['skipped', 'A backup is skipped']].map(([k, l]) => <Checkbox key={k} label={l} checked={notifyOn.includes(k)} onChange={() => setNotifyOn(toggleArr(notifyOn, k))} />)}</div>
            <Separator />
            <div><Label>{tx('Via')}</Label>{[['desktop', 'Server log and this page'], ['email', 'Email (needs SMTP_HOST on the server)']].map(([k, l]) => <Checkbox key={k} label={l} checked={notifyChannels.includes(k)} onChange={() => setNotifyChannels(toggleArr(notifyChannels, k))} />)}</div>
            {notifyChannels.includes('email') && <div><Label>{tx('Email address')}</Label><Input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} placeholder={tx('owner@example.com')} /></div>}
            <Hint>{tx('For alerts even when the server is off, set BACKUP_HEALTHCHECKS_PING_URL (e.g. a healthchecks.io check) on the server: it is pinged after every database backup and alerts when pings stop.')}</Hint>
          </Section>
        </TabsContent>

        {/* ===================================================================== */}
        {/* TAB: Advanced */}
        {/* ===================================================================== */}
        <TabsContent value="advanced" className="space-y-4 mt-4">
          <Section title={tx('Reliability')} icon={Settings2} desc="Applies to scheduled database backups">
            <div className="grid grid-cols-3 gap-2">
              <div><Label>{tx('Retries')}</Label><Input type="number" min={0} value={advRetry} onChange={(e) => setAdvRetry(Number(e.target.value))} /></div>
              <div><Label>{tx('Retry delay (min)')}</Label><Input type="number" min={0} value={advRetryDelay} onChange={(e) => setAdvRetryDelay(Number(e.target.value))} /></div>
              <div><Label>{tx('Timeout (min, 0 = none)')}</Label><Input type="number" min={0} value={advTimeout} onChange={(e) => setAdvTimeout(Number(e.target.value))} /></div>
            </div>
          </Section>
        </TabsContent>
      </Tabs>

      <Separator />

      {/* ===================================================================== */}
      {/* Database backups */}
      {/* ===================================================================== */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><History className="h-4 w-4" />{tx('Database backups')}</CardTitle><CardDescription>{tx('In the main backup folder, newest first. To recover the café from one, follow docs/backup-recovery.md.')}</CardDescription></CardHeader>
        <CardContent>
          {list.isLoading ? <Skeleton className="h-24 w-full" /> : !list.data?.length ? <p className="text-sm text-muted-foreground">{tx('No database backups yet.')}</p> : (
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {list.data.slice(0, 30).map((b) => (
                <div key={b.file} className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 text-xs">
                  <span className="font-mono truncate max-w-[22rem]" title={b.file}>{b.name}</span>
                  <span className="text-muted-foreground">{fmtTime(b.mtime)}</span>
                  <span className="text-muted-foreground">{fmtSize(b.size)}</span>
                  {b.encrypted ? <Badge variant="secondary" className="text-[10px]">{tx('encrypted')}</Badge> : <Badge variant="outline" className="text-[10px]">{tx('plain')}</Badge>}
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={verify.isPending} onClick={() => verify.mutate(b.name)}>{tx('Verify')}</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => runTest.mutate({ backupFile: b.name })}>{tx('Test restore')}</Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===================================================================== */}
      {/* Status Section */}
      {/* ===================================================================== */}
      <Card>
        <CardHeader><CardTitle>{tx('Status')}</CardTitle><CardDescription>{tx('Last results')}</CardDescription></CardHeader>
        <CardContent>
          {status.isLoading ? <Skeleton className="h-24 w-full" /> : (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {(['full', 'restore_test', 'files', 'config'] as BackupKind[]).map((kind) => {
                  const r = lastByKind?.[kind];
                  return (<div key={kind} className="rounded-lg border p-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">{KIND_LABELS[kind]}</span>{r ? <Badge variant={r.status === 'success' ? (r.warnings?.length && kind !== 'restore_test' ? 'secondary' : 'default') : r.status === 'failed' ? 'destructive' : 'outline'}>{r.status}</Badge> : <Badge variant="outline">{tx('never')}</Badge>}</div>{r && <div className="mt-2 text-xs text-muted-foreground space-y-1"><div>{fmtTime(r.finishedAt)}</div><div className="flex justify-between"><span>{r.sizeBytes ? `Size: ${fmtSize(r.sizeBytes)}` : ''}</span><span>{fmtDuration(r.durationMs)}</span></div>{r.error && <div className="text-destructive break-words">{r.error}</div>}{r.copies?.map((c) => <div key={c.destination} className={c.ok ? '' : 'text-destructive'}>{c.ok ? '✓' : '✗'} {c.destination}</div>)}</div>}</div>);
                })}
              </div>
              {status.data?.recent && status.data.recent.length > 0 && (
                <div><h4 className="text-sm font-medium mb-2">{tx('Recent history')}</h4><div className="space-y-1 max-h-48 overflow-y-auto">{status.data.recent.slice(0, 15).map((r, i) => (<div key={i} className="grid grid-cols-[6rem_4.5rem_1fr_4rem_3.5rem] items-center gap-2 text-xs border-b py-1"><span>{KIND_LABELS[r.kind] ?? r.kind}</span><Badge variant={r.status === 'success' ? 'default' : r.status === 'failed' ? 'destructive' : 'outline'} className="text-[10px] px-1.5 py-0 w-fit">{r.status}</Badge><span className="text-muted-foreground truncate" title={[r.error, ...(r.warnings ?? [])].filter(Boolean).join('\n')}>{fmtTime(r.finishedAt)}{r.error ? ` · ${r.error}` : r.warnings?.length ? ` · ${r.warnings[0]}` : ''}</span><span className="text-muted-foreground">{fmtSize(r.sizeBytes)}</span><span className="text-muted-foreground">{fmtDuration(r.durationMs)}</span></div>))}</div></div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
