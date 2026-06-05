"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";

const SSO_TYPE = process.env.NEXT_PUBLIC_SSO_TYPE as "oauth" | "saml" | undefined;
const SSO_LABEL = process.env.NEXT_PUBLIC_SSO_BUTTON_LABEL ?? "Sign in with SSO";
const SSO_EXCLUSIVE = process.env.NEXT_PUBLIC_SSO_EXCLUSIVE === "true";

export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ssoLoading, setSsoLoading] = useState(false);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleSsoSignIn = async () => {
        setSsoLoading(true);
        setError(null);
        try {
            const redirectTo = `${window.location.origin}/auth/callback`;
            if (SSO_TYPE === "saml") {
                const providerId = process.env.NEXT_PUBLIC_SSO_SAML_PROVIDER_ID;
                if (!providerId) throw new Error("SSO provider is not configured.");
                const { data, error } = await supabase.auth.signInWithSSO({
                    providerId,
                    options: { redirectTo },
                });
                if (error) throw error;
                if (data?.url) window.location.href = data.url;
            } else {
                const provider = process.env.NEXT_PUBLIC_SSO_OAUTH_PROVIDER;
                if (!provider) throw new Error("SSO provider is not configured.");
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { error } = await supabase.auth.signInWithOAuth({
                    provider: provider as any,
                    options: { redirectTo },
                });
                if (error) throw error;
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "SSO sign in failed");
            setSsoLoading(false);
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;

            router.push("/assistant");
        } catch (error: any) {
            setError(error.message || "An error occurred during login");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className="bg-white border border-gray-200 rounded-2xl p-8 mb-4">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-serif">
                            Log In
                        </h2>
                        <div className="bg-gray-100 p-1 rounded-md flex text-xs font-medium">
                            <span className="text-gray-600 px-3 py-1 bg-white rounded-sm shadow-sm">
                                Log in
                            </span>
                            <Link
                                href="/signup"
                                className="px-3 py-1 text-gray-500 hover:text-gray-900"
                            >
                                Sign up
                            </Link>
                        </div>
                    </div>
                    {SSO_TYPE && (
                        <>
                            <Button
                                type="button"
                                onClick={handleSsoSignIn}
                                disabled={ssoLoading}
                                className="w-full bg-black hover:bg-gray-900 text-white"
                            >
                                {ssoLoading ? "Redirecting…" : SSO_LABEL}
                            </Button>
                            {!SSO_EXCLUSIVE && (
                                <div className="relative my-6">
                                    <div className="absolute inset-0 flex items-center">
                                        <div className="w-full border-t border-gray-200" />
                                    </div>
                                    <div className="relative flex justify-center text-xs">
                                        <span className="bg-white px-3 text-gray-400">
                                            or continue with email
                                        </span>
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {(!SSO_TYPE || !SSO_EXCLUSIVE) && (
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label
                                htmlFor="email"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Email
                            </label>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Enter your email"
                                required
                                className="w-full"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Password
                            </label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter your password"
                                required
                                className="w-full"
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full mt-5 bg-black hover:bg-gray-900 text-white"
                        >
                            {loading ? "Logging in..." : "Log in"}
                        </Button>
                    </form>
                    )}
                </div>
                <p className="text-center text-xs text-gray-500 leading-relaxed px-2">
                    Mike hosted on MikeOSS.com is currently a demo service.
                    Please do not upload, submit, or store sensitive,
                    confidential, privileged, client, or personally
                    identifiable documents.
                </p>
            </div>
        </div>
    );
}
