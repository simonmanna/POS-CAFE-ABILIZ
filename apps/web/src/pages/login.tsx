// src/pages/LoginPage.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Building2, Eye, EyeOff, KeyRound, Loader2, LogIn, Mail, Monitor, Calendar, FileText, Coffee } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';

// CSS Styles
const styles = `
  .animated-gradient {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
    background-size: 400% 400%;
    animation: gradient-shift 15s ease infinite;
  }

  .glass-card {
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.3);
  }

  .btn-shine {
    position: relative;
    overflow: hidden;
  }

  .btn-shine::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
    transition: left 0.5s;
  }

  .btn-shine:hover::before {
    left: 100%;
  }

  .float-slow {
    animation: float 8s ease-in-out infinite;
  }

  .text-gradient {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  @keyframes gradient-shift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  @keyframes float {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    50% { transform: translateY(-20px) rotate(5deg); }
  }
`;

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
    <>
      <style>{styles}</style>
      <div className="animated-gradient flex min-h-screen items-center justify-center p-4 relative overflow-hidden">
        {/* Decorative floating blobs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-24 top-12 h-64 w-64 rounded-full bg-blue-400/20 blur-3xl float-slow" />
          <div className="absolute -right-24 bottom-12 h-72 w-72 rounded-full bg-orange-400/20 blur-3xl float-slow" style={{ animationDelay: '2s' }} />
          <div className="absolute right-1/3 top-1/4 h-48 w-48 rounded-full bg-indigo-400/15 blur-3xl float-slow" style={{ animationDelay: '4s' }} />
          <div className="absolute left-1/4 bottom-1/4 h-56 w-56 rounded-full bg-purple-400/15 blur-3xl float-slow" style={{ animationDelay: '3s' }} />
        </div>

        <div className="relative w-full max-w-5xl grid md:grid-cols-2 gap-6 items-center">
          {/* ── Brand panel ── */}
          <div className="hidden md:flex flex-col justify-between p-10 rounded-3xl text-white shadow-2xl shadow-blue-500/30 overflow-hidden relative min-h-[600px]"
               style={{ background: 'linear-gradient(135deg, hsl(217 91% 60%) 0%, hsl(230 90% 56%) 55%, hsl(24 95% 53%) 100%)' }}>
            <div className="absolute inset-0 opacity-30 pointer-events-none"
                 style={{ background: 'radial-gradient(at 90% 0%, rgba(255,255,255,0.25) 0%, transparent 50%), radial-gradient(at 0% 100%, rgba(255,255,255,0.18) 0%, transparent 50%)' }} />
            
            <div className="relative flex flex-col items-center justify-center flex-1 text-center">
              <div className="mb-8">
                <div className="inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md border border-white/30 mb-4">
                  <Coffee className="h-10 w-10 text-white" />
                </div>
                <div className="text-3xl font-extrabold tracking-tight">Cafe POS</div>
              </div>
              
              <h1 className="text-5xl font-extrabold leading-tight mb-6 max-w-md">
                Run your floor,<br />tables and till —<br />
                <span className="bg-white/20 px-3 py-1 rounded-lg backdrop-blur-sm">all in one place.</span>
              </h1>
            </div>

            <div className="relative grid grid-cols-3 gap-3 mt-10">
              <Feature icon={<Monitor className="h-5 w-5" />} label="Tables" />
              <Feature icon={<Calendar className="h-5 w-5" />} label="Reservations" />
              <Feature icon={<FileText className="h-5 w-5" />} label="Audit" />
            </div>
          </div>

          {/* ── Form panel ── */}
          <div className="glass-card p-8 md:p-12 rounded-3xl bg-white/80 backdrop-blur-xl shadow-2xl">
            {/* Mobile-only brand row */}
            <div className="md:hidden flex items-center gap-2 mb-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Coffee className="h-4 w-4" />
              </div>
              <div className="font-extrabold text-base text-gradient">Cafe POS</div>
            </div>

            <div className="mb-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-blue-600 mb-4">
                <Building2 className="h-6 w-6" />
              </div>
              <h2 className="text-2xl font-extrabold tracking-tight text-gray-900">
                {view === 'login' && 'Welcome back'}
                {view === 'mfa' && 'Two-factor authentication'}
                {view === 'forgot' && 'Reset your password'}
                {view === 'forgot-sent' && 'Check your inbox'}
              </h2>
              <p className="text-sm text-gray-500 mt-2">
                {view === 'login' && 'Sign in to your organization to continue.'}
                {view === 'mfa' && 'Enter the 6-digit code from your authenticator.'}
                {view === 'forgot' && "We'll email you a secure reset link."}
                {view === 'forgot-sent' && 'If the account exists, a reset link is on its way.'}
              </p>
            </div>

            {view === 'login' && (
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); login.mutate(); }}
              >
                <Field label="Organization Code">
                  <Input
                    value={orgCode}
                    onChange={(e) => setOrgCode(e.target.value)}
                    autoComplete="organization"
                    required
                    className="h-12 rounded-xl border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                    placeholder="DEMO"
                  />
                </Field>
                <Field label="Email">
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                    className="h-12 rounded-xl border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                    placeholder="your@email.com"
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
                      className="h-12 pr-12 rounded-xl border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPwd(!showPwd)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      aria-label={showPwd ? 'Hide password' : 'Show password'}
                    >
                      {showPwd ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                </Field>
                <Button
                  type="submit"
                  className="w-full h-12 font-bold btn-shine shadow-lg shadow-blue-500/25 rounded-xl bg-gradient-to-r from-blue-500 to-orange-500 hover:from-blue-600 hover:to-orange-600 text-white border-0"
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
                  className="block w-full text-center text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                >
                  Forgot password?
                </button>
              </form>
            )}

            {view === 'mfa' && (
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); mfa.mutate(); }}
              >
                <Field label="Authenticator code">
                  <Input
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    inputMode="numeric"
                    pattern="\\d{6}"
                    autoFocus
                    required
                    className="h-14 text-center text-2xl tracking-[0.4em] font-extrabold rounded-xl border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                  />
                </Field>
                <Button
                  type="submit"
                  className="w-full h-12 font-bold btn-shine rounded-xl bg-gradient-to-r from-blue-500 to-orange-500 hover:from-blue-600 hover:to-orange-600 text-white border-0"
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
                  className="block w-full text-center text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Back
                </button>
              </form>
            )}

            {view === 'forgot' && (
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); forgot.mutate(); }}
              >
                <Field label="Organization code">
                  <Input value={orgCode} onChange={(e) => setOrgCode(e.target.value)} required className="h-12 rounded-xl border-gray-200 focus:border-blue-500 focus:ring-blue-500" />
                </Field>
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-12 rounded-xl border-gray-200 focus:border-blue-500 focus:ring-blue-500" />
                </Field>
                <Button
                  type="submit"
                  className="w-full h-12 font-bold btn-shine rounded-xl bg-gradient-to-r from-blue-500 to-orange-500 hover:from-blue-600 hover:to-orange-600 text-white border-0"
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
                  className="block w-full text-center text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Back to sign in
                </button>
              </form>
            )}

            {view === 'forgot-sent' && (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-100 text-blue-600">
                  <Mail className="h-8 w-8" />
                </div>
                <p className="text-sm text-gray-600">
                  If an account exists for <strong className="text-gray-900">{email}</strong>,
                  a reset link has been sent.
                </p>
                <Button
                  variant="outline"
                  onClick={() => setView('login')}
                  className="w-full h-12 rounded-xl"
                >
                  Back to sign in
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="text-sm font-semibold text-gray-700 block mb-2">
      {label}
    </label>
    {children}
  </div>
);

const Feature: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div className="rounded-xl bg-white/20 backdrop-blur-md border border-white/30 px-4 py-3 flex items-center gap-2 text-sm font-bold">
    <div className="text-white">{icon}</div>
    <span>{label}</span>
  </div>
);