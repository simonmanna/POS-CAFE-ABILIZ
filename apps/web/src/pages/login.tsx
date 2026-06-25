import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Building2, Eye, EyeOff, KeyRound, Loader2, LogIn, Mail, Sparkles, ShieldCheck, Coffee } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; firstName: string; lastName: string | null; roles: string[] };
  permissions: string[];
  organization?: { id: string; code: string; name: string; currencyCode: string; timezone: string };
}

type View = 'login' | 'mfa' | 'forgot' | 'forgot-sent';

export function LoginPage() {
  const [view, setView] = useState<View>('login');
  const [orgCode, setOrgCode] = useState('DEMO');
  const [email, setEmail] = useState('admin@demo.test');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);

  const login = useMutation({
    mutationFn: async () =>
      (await api.post<LoginResponse>('/auth/login', { organizationCode: orgCode, email, password })).data,
    onSuccess: (data) => {
      if ((data as any).requiresMfa) {
        setMfaToken((data as any).mfaToken);
        setView('mfa');
        return;
      }
      setSession(data);
      notify.success(`Welcome back, ${data.user.firstName}`);
      navigate('/');
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Sign in failed'),
  });
  const mfa = useMutation({
    mutationFn: async () =>
      (await api.post<LoginResponse>('/auth/mfa-login', { mfaToken, code: mfaCode })).data,
    onSuccess: (data) => {
      setSession(data);
      notify.success(`Welcome back, ${data.user.firstName}`);
      navigate('/');
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Invalid MFA code'),
  });
  const forgot = useMutation({
    mutationFn: async () => (await api.post('/auth/forgot-password', { organizationCode: orgCode, email })).data,
    onSuccess: () => setView('forgot-sent'),
    onError: () => setView('forgot-sent'),
  });

  return (
    <div className="animated-gradient flex min-h-screen items-center justify-center p-4">
      {/* Decorative floating blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 top-12 h-64 w-64 rounded-full bg-blue-400/20 blur-3xl float-slow" />
        <div className="absolute -right-24 bottom-12 h-72 w-72 rounded-full bg-orange-400/20 blur-3xl float-slow" style={{ animationDelay: '2s' }} />
        <div className="absolute right-1/3 top-1/4 h-48 w-48 rounded-full bg-indigo-400/15 blur-3xl float-slow" style={{ animationDelay: '4s' }} />
      </div>

      <div className="relative w-full max-w-5xl grid md:grid-cols-2 gap-6 items-center">
        {/* ── Brand panel ── */}
        <div className="hidden md:flex flex-col justify-between p-10 rounded-3xl text-white shadow-2xl shadow-blue-500/30 overflow-hidden relative"
             style={{ background: 'linear-gradient(135deg, hsl(217 91% 60%) 0%, hsl(230 90% 56%) 55%, hsl(24 95% 53%) 100%)' }}>
          <div className="absolute inset-0 opacity-30 pointer-events-none"
               style={{ background: 'radial-gradient(at 90% 0%, rgba(255,255,255,0.25) 0%, transparent 50%), radial-gradient(at 0% 100%, rgba(255,255,255,0.18) 0%, transparent 50%)' }} />
          <div className="relative">
            <div className="flex items-center gap-3 mb-12">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md border border-white/30">
                <Coffee className="h-6 w-6" />
              </div>
              <div>
                <div className="text-xl font-extrabold tracking-tight">Cafe POS</div>
                <div className="text-xs font-medium text-white/80 uppercase tracking-[0.18em]">Point of Sale</div>
              </div>
            </div>
            <h1 className="text-4xl font-extrabold leading-tight mb-3">
              Run your floor,<br />tables and till —<br />
              <span className="bg-white/20 px-2 rounded-md backdrop-blur-sm">all in one place.</span>
            </h1>
            <p className="text-white/85 text-sm max-w-sm leading-relaxed">
              Take orders, manage tables, track reservations, and close shifts
              with a fast, friendly POS that scales from a single coffee bar
              to a multi-floor restaurant.
            </p>
          </div>

          <div className="relative grid grid-cols-3 gap-3 mt-10">
            <Feature icon={<Sparkles className="h-4 w-4" />} label="Tables" />
            <Feature icon={<KeyRound className="h-4 w-4" />} label="Reservations" />
            <Feature icon={<ShieldCheck className="h-4 w-4" />} label="Audit" />
          </div>
        </div>

        {/* ── Form panel ── */}
        <div className="glass-card p-8">
          {/* Mobile-only brand row */}
          <div className="md:hidden flex items-center gap-2 mb-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Coffee className="h-4 w-4" />
            </div>
            <div className="font-extrabold text-base text-gradient">Cafe POS</div>
          </div>

          <div className="mb-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary mb-3">
              <Building2 className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-extrabold tracking-tight">
              {view === 'login' && 'Welcome back'}
              {view === 'mfa' && 'Two-factor authentication'}
              {view === 'forgot' && 'Reset your password'}
              {view === 'forgot-sent' && 'Check your inbox'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {view === 'login' && 'Sign in to your organization to continue.'}
              {view === 'mfa' && 'Enter the 6-digit code from your authenticator.'}
              {view === 'forgot' && "We'll email you a secure reset link."}
              {view === 'forgot-sent' && 'If the account exists, a reset link is on its way.'}
            </p>
          </div>

          {view === 'login' && (
            <form
              className="space-y-3.5"
              onSubmit={(e) => { e.preventDefault(); login.mutate(); }}
            >
              <Field label="Organization code">
                <Input
                  value={orgCode}
                  onChange={(e) => setOrgCode(e.target.value)}
                  autoComplete="organization"
                  required
                  className="h-11"
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  className="h-11"
                />
              </Field>
              <Field label="Password">
                <div className="relative">
                  <Input
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className="h-11 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd(!showPwd)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPwd ? 'Hide password' : 'Show password'}
                  >
                    {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
              <Button
                type="submit"
                className="w-full h-11 font-bold btn-shine shadow-lg shadow-blue-500/25"
                disabled={login.isPending}
              >
                {login.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <LogIn className="mr-2 h-4 w-4" />}
                Sign in
              </Button>
              <button
                type="button"
                onClick={() => setView('forgot')}
                className="block w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Forgot your password?
              </button>
            </form>
          )}

          {view === 'mfa' && (
            <form
              className="space-y-3.5"
              onSubmit={(e) => { e.preventDefault(); mfa.mutate(); }}
            >
              <Field label="Authenticator code">
                <Input
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                  pattern="\d{6}"
                  autoFocus
                  required
                  className="h-12 text-center text-2xl tracking-[0.4em] font-extrabold"
                />
              </Field>
              <Button
                type="submit"
                className="w-full h-11 font-bold btn-shine"
                disabled={mfa.isPending || mfaCode.length !== 6}
              >
                {mfa.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <KeyRound className="mr-2 h-4 w-4" />}
                Verify
              </Button>
              <button
                type="button"
                onClick={() => setView('login')}
                className="block w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Back
              </button>
            </form>
          )}

          {view === 'forgot' && (
            <form
              className="space-y-3.5"
              onSubmit={(e) => { e.preventDefault(); forgot.mutate(); }}
            >
              <Field label="Organization code">
                <Input value={orgCode} onChange={(e) => setOrgCode(e.target.value)} required className="h-11" />
              </Field>
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11" />
              </Field>
              <Button
                type="submit"
                className="w-full h-11 font-bold btn-shine"
                disabled={forgot.isPending}
              >
                {forgot.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Mail className="mr-2 h-4 w-4" />}
                Send reset link
              </Button>
              <button
                type="button"
                onClick={() => setView('login')}
                className="block w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Back to sign in
              </button>
            </form>
          )}

          {view === 'forgot-sent' && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Mail className="h-7 w-7" />
              </div>
              <p className="text-sm text-muted-foreground">
                If an account exists for <strong className="text-foreground">{email}</strong>,
                a reset link has been sent.
              </p>
              <Button
                variant="outline"
                onClick={() => setView('login')}
                className="w-full h-11"
              >
                Back to sign in
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
      {label}
    </label>
    {children}
  </div>
);

const Feature: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div className="rounded-xl bg-white/15 backdrop-blur-md border border-white/20 px-3 py-2.5 flex items-center gap-2 text-xs font-bold">
    <div className="text-white/90">{icon}</div>
    <span>{label}</span>
  </div>
);