"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { SiteLogo } from "@/components/site-logo";

function CallbackHandler() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const errorParam = searchParams.get("error");
        const errorDescription = searchParams.get("error_description");
        const code = searchParams.get("code");

        if (errorParam) {
            setError(errorDescription ?? "Authentication failed. Please try again.");
            return;
        }

        if (code) {
            // OAuth PKCE flow — exchange authorisation code for a session.
            supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
                if (error) {
                    setError(error.message);
                } else {
                    router.replace("/assistant");
                }
            });
            return;
        }

        // SAML / implicit flow — session arrives as a hash fragment that the
        // Supabase JS client detects automatically. Check immediately, then
        // fall back to onAuthStateChange for flows that take a moment longer.
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
                router.replace("/assistant");
                return;
            }

            const { data: { subscription } } = supabase.auth.onAuthStateChange(
                (_event, session) => {
                    if (session) {
                        subscription.unsubscribe();
                        router.replace("/assistant");
                    }
                },
            );

            const timeout = setTimeout(() => {
                subscription.unsubscribe();
                router.replace("/login");
            }, 5000);

            return () => {
                clearTimeout(timeout);
                subscription.unsubscribe();
            };
        });
    }, [searchParams, router]);

    if (error) {
        return (
            <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="md" className="md:text-4xl" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center">
                        <p className="text-red-600 text-sm mb-4">{error}</p>
                        <a
                            href="/login"
                            className="text-sm text-blue-600 hover:underline"
                        >
                            Return to login
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh bg-white flex items-center justify-center">
            <p className="text-gray-500 text-sm">Completing sign in…</p>
        </div>
    );
}

export default function AuthCallbackPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-dvh bg-white flex items-center justify-center">
                    <p className="text-gray-500 text-sm">Completing sign in…</p>
                </div>
            }
        >
            <CallbackHandler />
        </Suspense>
    );
}
