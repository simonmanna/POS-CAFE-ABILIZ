import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import '../../styles/login.css';

/**
 * Cashier / staff PIN login.
 *
 * Security-relevant behaviour:
 *   - Calls the real loginWithPin method on the AuthContext (the previous
 *     implementation called an undefined login and threw at runtime).
 *   - Surfaces server-supplied error messages (so a locked account tells
 *     the cashier when it unlocks, rather than a generic "Invalid PIN").
 *   - Caps PIN length at 8 digits to match the backend regex.
 *   - Disables input while a request is in flight to prevent double-submits.
 *   - Auto-submits as soon as 4 digits are entered (cashier speed-of-use).
 *   - Pressing Escape clears the buffer; Backspace deletes one digit.
 */
const LoginPage: React.FC = () => {
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { loginWithPin, isAuthenticated, user } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    // Redirect when authenticated
    useEffect(() => {
        if (isAuthenticated && user) {
            const from = (location.state as any)?.from?.pathname;
            if (from) {
                navigate(from, { replace: true });
            } else if (user.role === 'ADMIN') {
                navigate('/', { replace: true });
            } else {
                navigate('/pos', { replace: true });
            }
        }
    }, [isAuthenticated, user, navigate, location]);

    const submit = useCallback(async (enteredPin: string) => {
        if (loading) return;
        setLoading(true);
        setError('');
        try {
            await loginWithPin(enteredPin);
            // Navigation handled by useEffect
        } catch (err: any) {
            // Axios error: prefer server message, otherwise generic text.
            const msg =
                err?.response?.data?.message ||
                err?.response?.data?.error ||
                err?.message ||
                'Invalid PIN. Please try again.';
            setError(msg);
            setPin('');
        } finally {
            setLoading(false);
        }
    }, [loading, loginWithPin]);

    const handleDigit = (digit: string) => {
        if (loading) return;
        setError('');
        setPin((current) => {
            if (current.length >= 8) return current; // backend caps at 8 digits
            const next = current + digit;
            // Auto-submit at 4 digits to mirror the original UX.
            if (next.length === 4) {
                // Defer the state-setting side effect so we don't call submit
                // with a stale closure value.
                setTimeout(() => submit(next), 0);
            }
            return next;
        });
    };

    const handleBackspace = () => {
        if (loading) return;
        setError('');
        setPin((p) => p.slice(0, -1));
    };

    const handleClear = () => {
        if (loading) return;
        setError('');
        setPin('');
    };

    // Keyboard support
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (loading) return;
            if (e.key >= '0' && e.key <= '9') {
                handleDigit(e.key);
            } else if (e.key === 'Backspace') {
                handleBackspace();
            } else if (e.key === 'Escape') {
                handleClear();
            } else if (e.key === 'Enter' && pin.length >= 4) {
                submit(pin);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [pin, loading, submit]);

    return (
        <div className="login-container">
            <div className="login-bg-orbs">
                <div className="orb orb-1"></div>
                <div className="orb orb-2"></div>
                <div className="orb orb-3"></div>
            </div>

            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo">
                        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
                            <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
                            <line x1="6" y1="1" x2="6" y2="4"/>
                            <line x1="10" y1="1" x2="10" y2="4"/>
                            <line x1="14" y1="1" x2="14" y2="4"/>
                        </svg>
                    </div>
                    <h1>CafePOS</h1>
                    <p className="login-subtitle">Enter your PIN to continue</p>
                </div>

                <div className="pin-dots">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                        <div
                            key={i}
                            className={`pin-dot${i < pin.length ? ' filled' : ''}${loading ? ' pulse' : ''}`}
                        ></div>
                    ))}
                </div>

                {error && (
                    <div className="login-error" role="alert">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, verticalAlign: 'middle' }}>
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        {error}
                    </div>
                )}

                <div className="pin-pad">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                        <button
                            key={digit}
                            type="button"
                            className="pin-btn"
                            onClick={() => handleDigit(digit)}
                            disabled={loading}
                        >
                            {digit}
                        </button>
                    ))}
                    <button type="button" className="pin-btn pin-btn-action" onClick={handleClear} disabled={loading}>
                        C
                    </button>
                    <button type="button" className="pin-btn" onClick={() => handleDigit('0')} disabled={loading}>
                        0
                    </button>
                    <button type="button" className="pin-btn pin-btn-action" onClick={handleBackspace} disabled={loading}>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
                            <line x1="18" y1="9" x2="12" y2="15"/>
                            <line x1="12" y1="9" x2="18" y2="15"/>
                        </svg>
                    </button>
                </div>

                <div className="login-footer">
                    <small>
                        Demo PINs: <strong>1234</strong> (Admin) · <strong>5678</strong> (Cashier) · <strong>0000</strong> (Waiter)
                    </small>
                    {/*
                       The previous link pointed at /register, which was a public
                       self-service page backed by an unguarded POST /users/register.
                       That route has been removed for security reasons. Staff
                       accounts are now created by an administrator from /staff.
                    */}
                    <br />
                    <small style={{ color: '#9CA3AF', marginTop: '8px', display: 'block' }}>
                        Need an account? <Link to="/login" style={{ color: '#16A34A', textDecoration: 'none' }}>Ask your administrator</Link>
                    </small>
                </div>
            </div>
        </div>
    );
};

export default LoginPage;
