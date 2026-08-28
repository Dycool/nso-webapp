/**
 * Interactive sign-in flow and authentication gate wiring.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

function setAuthButtonsDisabled(disabled, label = null) {
    const submitGateBtn = document.getElementById('submitAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn');
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const beginSignInBtn = document.getElementById('beginSignInBtn');

    if (submitGateBtn) {
        submitGateBtn.disabled = disabled;
        if (label) submitGateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
        else submitGateBtn.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> ${escapeHtml(trKey('Tutorial_Button_Login'))}`;
    }
    if (pasteAuthGateBtn) pasteAuthGateBtn.disabled = disabled;
    if (oauthGateBtn) {
        oauthGateBtn.disabled = disabled;
        if (disabled) oauthGateBtn.classList.add('disabled');
        else oauthGateBtn.classList.remove('disabled');
    }
    if (beginSignInBtn) beginSignInBtn.disabled = disabled;
}

function setAuthGateHint(_text) {
    // Login progress/errors are shown through the button state and error dialogs.
    // Keep the area below “Paste from clipboard” clean instead of exposing internal
    // authentication-stage/debug text in the UI.
}

// Nintendo session_token_code values are single-use. If the code exchange succeeds
// but a later authentication stage fails, retain only the resulting session_token in
// page memory so retrying the same pasted value does not attempt to consume the code
// a second time. This is intentionally never persisted to web storage.
let failedLoginRetry = null;

async function performFullAuthentication(options = {}) {
    if (loginInFlight) {
        const authProgMsg = typeof tr === 'function' ? tr('Authentication already in progress, awaiting active flow.') : 'Authentication already in progress, awaiting active flow.';
        console.log(`[Auth] ${authProgMsg}`);
        return loginInFlight;
    }

    // Immediately disable buttons BEFORE any await
    setAuthButtonsDisabled(true, 'Signing in...');

    loginInFlight = (async () => {
        const isResume = options.isResume === true;
        try {
            // Do not contact nxapi just to check a remembered/brokered Coral session.
            // Consent is enforced at the exact point an nxapi request becomes necessary.
            let idToken = null;
            let accessToken = null;
            let longLivedSessionToken = null;

            if (isResume) {
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Resuming your saved Nintendo Account session…');

                let resumeResp;
                try {
                    resumeResp = await fetch(`${WORKER_URL}/api/nso/remember/resume`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    throw new AuthStageError('REMEMBER_RESUME', `Network error contacting remember service: ${e.message}`, e);
                }

                if (!resumeResp.ok) {
                    localStorage.removeItem('nso_has_remembered_account');
                    localStorage.removeItem('nso_remember_expires_at');
                    updateRememberedUI();
                    let errMsg = `HTTP ${resumeResp.status}`;
                    try {
                        const errData = await resumeResp.json();
                        errMsg = errData.error || errMsg;
                    } catch { }
                    throw new AuthStageError('REMEMBER_RESUME', `Remembered session expired or revoked: ${errMsg}`, null, resumeResp.status);
                }

                const resumeData = await resumeResp.json();
                idToken = resumeData.idToken;
                accessToken = resumeData.accessToken;
            } else {
                const input = (options.input || document.getElementById('idTokenGateInput')?.value || '').trim();
                if (!input) {
                    throw new Error('Please paste the redirect URL or session_token string.');
                }

                // A retry token belongs only to the exact pasted value that produced it.
                // Submitting anything else immediately drops the old in-memory credential.
                if (failedLoginRetry?.input !== input) failedLoginRetry = null;

                // Direct JSON Session or AccessToken input support
                if (input.startsWith('{') && input.endsWith('}')) {
                    try {
                        const jsonSession = JSON.parse(input);
                        const expiresIn = Number(jsonSession?.result?.webApiServerCredential?.expiresIn || 7200);
                        jsonSession.nsoWebapp = {
                            ...(jsonSession.nsoWebapp || {}),
                            coralExpiresAt: Number(jsonSession?.nsoWebapp?.coralExpiresAt || 0) || Date.now() + expiresIn * 1000,
                            zncaVersion: validZncaVersion(jsonSession?.nsoWebapp?.zncaVersion) ? jsonSession.nsoWebapp.zncaVersion : BUNDLED_ZNCA_VERSION
                        };
                        failedLoginRetry = null;
                        userSession = jsonSession;
                        applySessionZncaVersion(jsonSession);
                        sessionStorage.setItem('nso_user_session', JSON.stringify(jsonSession));
                        showAuthenticatedUI(jsonSession);
                        return;
                    } catch (e) { }
                }

                let code = input;
                let returnedState = null;
                if (input.includes('session_token_code=')) {
                    const hashPart = input.split('#')[1] || input.split('?')[1] || input;
                    const urlParams = new URLSearchParams(hashPart);
                    code = urlParams.get('session_token_code') || code;
                    returnedState = urlParams.get('state') || null;
                }

                const retrySessionToken = failedLoginRetry?.input === input
                    ? failedLoginRetry.sessionToken
                    : null;

                const expectedState = localStorage.getItem('nso_auth_state');
                if (returnedState && expectedState && returnedState !== expectedState) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        'OAuth state mismatch. The sign-in response did not match the expected authentication request. Please click "Open Nintendo Sign In" again.'
                    );
                }

                const verifier = localStorage.getItem('nso_pkce_verifier');
                if (!retrySessionToken && !verifier && (input.includes('session_token_code=') || input.length < 120)) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        'PKCE verifier missing. Please click "Open Nintendo Sign In" again to start a new authentication session.'
                    );
                }

                if (retrySessionToken) {
                    // The one-time code was already exchanged successfully during the
                    // previous attempt. Continue from the reusable Nintendo session token.
                    longLivedSessionToken = retrySessionToken;
                    setAuthButtonsDisabled(true, 'Signing in...');
                    setAuthGateHint('Retrying Nintendo Account authentication…');
                } else {
                    // Step 1: Exchange session_token_code + session_token_code_verifier -> session_token
                    setAuthButtonsDisabled(true, 'Signing in...');
                    setAuthGateHint('Exchanging session authorization code with Nintendo…');

                    const formBody = new URLSearchParams({
                        client_id: '71b963c1b7b6d119',
                        session_token_code: code,
                        session_token_code_verifier: verifier || ''
                    });

                    const step1Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/session_token', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                        },
                        body: formBody.toString()
                    });
                    const step1Data = await step1Resp.json().catch(() => ({}));

                    if (!step1Resp.ok || !step1Data.session_token) {
                        throw new AuthStageError(
                            'NINTENDO_SESSION_TOKEN_EXCHANGE',
                            `Nintendo session code exchange failed: ${step1Data.error || step1Data.errorMessage || 'Invalid session_token_code'} (HTTP ${step1Resp.status})`,
                            null,
                            step1Resp.status
                        );
                    }

                    longLivedSessionToken = step1Data.session_token;
                    failedLoginRetry = { input, sessionToken: longLivedSessionToken };
                    localStorage.removeItem('nso_pkce_verifier');
                    localStorage.removeItem('nso_auth_state');
                }

                // Step 2: Exchange session_token -> id_token & access_token (JWT)
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Requesting Nintendo Account tokens…');

                const step2Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                    },
                    body: JSON.stringify({
                        client_id: '71b963c1b7b6d119',
                        session_token: longLivedSessionToken,
                        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token'
                    })
                });
                const step2Data = await step2Resp.json().catch(() => ({}));

                if (!step2Resp.ok || !step2Data.id_token) {
                    throw new AuthStageError(
                        'NINTENDO_ID_TOKEN_EXCHANGE',
                        `Nintendo token exchange failed: ${step2Data.error_description || step2Data.error || 'Failed to obtain id_token'} (HTTP ${step2Resp.status})`,
                        null,
                        step2Resp.status
                    );
                }

                idToken = step2Data.id_token;
                accessToken = step2Data.access_token;
            }

            // Start the account broker once. The Worker already validates the Nintendo
            // access token against /users/me to derive the account key, so return that
            // same profile instead of making the browser perform the identical request
            // a second time. This removes one Nintendo + Cloudflare round trip from login.
            setAuthButtonsDisabled(true, 'Signing in...');
            let data = null;
            let brokerReady = false;
            let brokerSession = null;
            let userInfo = null;
            try {
                brokerSession = await startTokenBrokerSession(accessToken);
                brokerReady = true;
                userInfo = brokerSession?.profile || null;
            } catch (error) {
                // Backward compatibility / temporary Worker outage: only then use the
                // canonical client-side profile + Coral path. Never fall back after an
                // nxapi/Coral response from the broker, which would double-spend auth.
                console.warn('[AccountTokenBroker] Session unavailable; using canonical Coral login path:', error);
            }

            if (!userInfo) {
                const userResp = await proxyFetch('https://api.accounts.nintendo.com/2.0.0/users/me', {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept-Language': (typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB'),
                        'User-Agent': 'NASDKAPI; Android',
                        'Accept': 'application/json'
                    }
                });
                if (!userResp.ok) {
                    throw new AuthStageError(
                        'NINTENDO_PROFILE',
                        `Failed to retrieve Nintendo Account profile (HTTP ${userResp.status}).`,
                        null,
                        userResp.status
                    );
                }
                userInfo = await userResp.json().catch(() => ({}));
            }

            if (!userInfo?.id || !userInfo?.country || !userInfo?.language || !userInfo?.birthday) {
                throw new AuthStageError(
                    'NINTENDO_PROFILE',
                    'Nintendo Account profile is missing required fields (id, country, language, or birthday).'
                );
            }

            const naId = userInfo.id;
            const language = userInfo.language;
            const naCountry = userInfo.country;
            const naBirthday = userInfo.birthday;

            if (brokerReady && validBrokerCoralSession(brokerSession?.coral, naId)) {
                data = brokerSession.coral.session;
            }

            if (!data) {
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Generating Coral session token…');
                try {
                    data = await generateCoralViaTokenBroker({
                        idToken,
                        naId,
                        language,
                        country: naCountry,
                        birthday: naBirthday
                    });
                    const brokerMsg = typeof tr === 'function' ? tr('Coral cache filled from one method-1 generation.') : 'Coral cache filled from one method-1 generation.';
                    console.log(`[AccountTokenBroker] ${brokerMsg}`);
                } catch (brokerErr) {
                    if (window.nsoBackendMode === 'extension') {
                        console.warn('[AccountTokenBroker] Broker generation failed; trying fallback:', brokerErr);
                    } else {
                        throw brokerErr;
                    }
                }
            }

            if (!data && window.nsoBackendMode === 'extension') {
                await prepareNxapi();
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Generating Coral attestation f-token with nxapi…');

                let attestation;
                try {
                    attestation = await nxapiGenerateF(1, idToken, { na_id: naId });
                } catch (err) {
                    if (err instanceof AuthStageError) throw err;
                    throw new AuthStageError('NXAPI_F_METHOD_1', `nxapi attestation failed: ${err.message}`, err);
                }

                const { f: fToken, timestamp: timestampMs, requestId } = attestation;

                // Step 5: Encrypt Coral Account/Login payload
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Encrypting Coral login request…');

                const coralLoginUrl = 'https://api-lp1.znc.srv.nintendo.net/v4/Account/Login';
                const coralLoginBody = JSON.stringify({
                    parameter: {
                        f: fToken,
                        naIdToken: idToken,
                        timestamp: timestampMs,
                        requestId: requestId,
                        language,
                        naCountry,
                        naBirthday
                    }
                });

                let encryptedLoginBody;
                try {
                    encryptedLoginBody = await nxapiEncryptRequest(coralLoginUrl, null, coralLoginBody);
                } catch (err) {
                    if (err instanceof AuthStageError) throw err;
                    throw new AuthStageError('NXAPI_ENCRYPT_ACCOUNT_LOGIN', `nxapi login encryption failed: ${err.message}`, err);
                }

                // Step 6: Post to Coral /v4/Account/Login
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Connecting to Nintendo Switch Online Coral service…');

                const coralResp = await proxyFetch(coralLoginUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Accept': 'application/octet-stream,application/json',
                        'Accept-Language': (typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB'),
                        'Pragma': 'no-cache',
                        'Cache-Control': 'no-cache',
                        'X-ProductVersion': ZNCA_VERSION,
                        'X-Platform': ZNCA_PLATFORM,
                        'User-Agent': zncaUserAgent()
                    },
                    bodyBase64: encryptedLoginBody
                });

                data = null;
                try {
                    data = await parseCoralResponse(coralResp);
                } catch (err) {
                    throw new AuthStageError('NXAPI_DECRYPT_ACCOUNT_LOGIN', `Could not decrypt Coral response: ${err.message}`, err);
                }

                if (!coralResp.ok || !data?.result) {
                    throw new AuthStageError(
                        'CORAL_ACCOUNT_LOGIN',
                        `Coral login failed (${data?.status || 'Error'}): ${data?.errorMessage || data?.error || 'Authentication rejected'} (HTTP ${coralResp.status})`,
                        null,
                        coralResp.status
                    );
                }

            }

            // Authentication succeeded! Derive expiresAt strictly from Coral's webApiServerCredential.expiresIn
            const expiresInSec = Number(data.result?.webApiServerCredential?.expiresIn || 7200);
            const brokerExpiresAt = Number(data?.nsoWebapp?.coralExpiresAt || 0);
            data.nsoWebapp = {
                ...(data.nsoWebapp || {}),
                naId,
                zncaVersion: validZncaVersion(data?.nsoWebapp?.zncaVersion)
                    ? data.nsoWebapp.zncaVersion
                    : activeZncaVersion(),
                // A broker cache hit carries the original absolute expiry. Never
                // extend it merely because another device reused the same token.
                coralExpiresAt: brokerExpiresAt > Date.now()
                    ? brokerExpiresAt
                    : Date.now() + expiresInSec * 1000
            };
            userSession = data;
            applySessionZncaVersion(data);
            bindNxapiCoralContext(naId, activeZncaVersion(data));
            sessionStorage.setItem('nso_user_session', JSON.stringify(data));

            // Persist Remember Me ONLY after complete Coral Account/Login flow succeeds!
            const rememberCheckbox = document.getElementById('rememberMeCheckbox');
            const shouldRemember = rememberCheckbox?.checked === true;

            if (isResume) {
                // Resuming an existing remembered account must not treat the hidden,
                // unchecked Remember Me box as an opt-out. Keep the existing grant
                // until the user explicitly signs out or forgets it from their profile.
                if (hasRememberedAccount()) {
                    localStorage.setItem('nso_user_session', JSON.stringify(data));
                }
                updateRememberedUI();
            } else if (shouldRemember && longLivedSessionToken) {
                try {
                    setAuthGateHint('Saving encrypted session on server…');
                    const remResp = await fetch(`${WORKER_URL}/api/nso/remember/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ sessionToken: longLivedSessionToken })
                    });
                    if (remResp.ok) {
                        const rememberData = await remResp.json().catch(() => ({}));
                        const rememberExpiresAt = Number(rememberData.expiresAt || 0);
                        if (rememberExpiresAt > Date.now()) {
                            localStorage.setItem('nso_has_remembered_account', 'true');
                            localStorage.setItem('nso_remember_expires_at', String(rememberExpiresAt));
                            localStorage.setItem('nso_user_session', JSON.stringify(data));
                        } else {
                            localStorage.removeItem('nso_has_remembered_account');
                            localStorage.removeItem('nso_remember_expires_at');
                        }
                        updateRememberedUI();
                    } else {
                        const err = await remResp.json().catch(() => ({}));
                        console.warn('[RememberMe] Save rejected:', err.error);
                    }
                } catch (e) {
                    console.warn('[RememberMe] Save error:', e);
                }
            } else {
                // Treat an unchecked Remember Me box as an explicit opt-out for
                // this browser. Revoke any older remember grant/cookie so the
                // account broker cannot remain persistent because of stale local
                // consent from a previous sign-in on this browser.
                localStorage.removeItem('nso_has_remembered_account');
                localStorage.removeItem('nso_remember_expires_at');
                localStorage.removeItem('nso_user_session');
                localStorage.removeItem('nso_gws_tokens');
                try {
                    await fetch(`${WORKER_URL}/api/nso/remember/forget`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    console.warn('[RememberMe] Could not revoke an older remember grant:', e);
                }
                updateRememberedUI();
            }

            // The retry credential is no longer needed once the full flow succeeds.
            failedLoginRetry = null;
            pendingRememberedResume = false;
            document.getElementById('loginWorkflow')?.classList.remove('remembered-consent-only');
            setAuthGateHint('');
            showAuthenticatedUI(data);
        } catch (err) {
            if (isResume && err instanceof AuthStageError && err.stage === 'NXAPI_AUTH' && !hasNxapiConsent()) {
                // The remembered Nintendo session is still usable, but Coral itself
                // needs refreshing. Show only the required nxapi disclosure; no
                // remembered-account card or Nintendo sign-in/paste steps.
                pendingRememberedResume = true;
                const workflow = document.getElementById('loginWorkflow');
                workflow?.classList.add('remembered-consent-only');
                workflow?.classList.remove('hidden');
                document.getElementById('beginSignInBtn')?.classList.add('hidden');
                document.querySelector('.login-help')?.classList.add('hidden');
                workflow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            // If authentication failed after opening an ephemeral broker lease,
            // release it immediately. Without Remember Me this causes the account
            // cache to be purged now instead of waiting for the 90-second crash
            // fail-safe lease timeout.
            if (!userSession) releaseTokenBrokerSession({ keepalive: true });
            console.error('[Auth Error]', err);
            const displayMsg = userFacingErrorMessage(err, 'Error_Dialog_Message_Login_Failed');
            alert(displayMsg);
            setAuthGateHint(displayMsg);
        } finally {
            loginInFlight = null;
            setAuthButtonsDisabled(false);
        }
    })();

    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
        setAuthButtonsDisabled(false);
    }
}

function initAuthGate() {
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const submitGateBtn = document.getElementById('submitAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn');
    const beginSignInBtn = document.getElementById('beginSignInBtn');
    const loginWorkflow = document.getElementById('loginWorkflow');
    const authInput = document.getElementById('idTokenGateInput');
    const profileForgetRememberedBtn = document.getElementById('profileForgetRememberedBtn');
    const nxapiConsentCheckbox = document.getElementById('nxapiConsentCheckbox');
    const nxapiDisclosure = document.getElementById('nxapiDisclosure');

    const requireNxapiConsent = () => {
        if (window.nsoBackendMode !== 'extension') return true;
        if (nxapiConsentCheckbox?.checked) {
            nxapiDisclosure?.classList.remove('needs-consent');
            return true;
        }
        nxapiDisclosure?.classList.add('needs-consent');
        nxapiConsentCheckbox?.focus();
        nxapiConsentCheckbox?.reportValidity?.();
        return false;
    };

    nxapiConsentCheckbox?.addEventListener('change', () => {
        nxapiDisclosure?.classList.toggle('needs-consent', !nxapiConsentCheckbox.checked);
        if (nxapiConsentCheckbox.checked && window.nsoBackendMode === 'extension') {
            void warmNxapiForLogin().catch(() => { });
        }
    });

    let pasteDebounceTimer = null;
    const continueWithPastedRedirect = () => {
        if (pasteDebounceTimer) clearTimeout(pasteDebounceTimer);
        pasteDebounceTimer = setTimeout(() => {
            const value = authInput?.value.trim() || '';
            if (!value || !(value.includes('session_token_code=') || value.startsWith('eyJ') || value.startsWith('{'))) return;
            if (!requireNxapiConsent()) return;
            performFullAuthentication({ input: value });
        }, 300);
    };

    if (beginSignInBtn) {
        beginSignInBtn.addEventListener('click', () => {
            if (hasRememberedAccount()) {
                pendingRememberedResume = true;
                // Reuse the remembered Nintendo session behind the normal Sign In
                // button. There is intentionally no separate remembered-account card.
                performFullAuthentication({ isResume: true });
                return;
            }

            pendingRememberedResume = false;
            loginWorkflow.classList.remove('remembered-consent-only');
            loginWorkflow.classList.remove('hidden');
            beginSignInBtn.classList.add('hidden');
            document.querySelector('.login-help')?.classList.add('hidden');
            loginWorkflow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    if (authInput) {
        authInput.addEventListener('paste', continueWithPastedRedirect);
    }

    if (pasteAuthGateBtn) {
        pasteAuthGateBtn.addEventListener('click', async () => {
            try {
                const clipboardText = await navigator.clipboard.readText();
                if (!clipboardText) throw new Error('Your clipboard is empty.');
                authInput.value = clipboardText.trim();
                continueWithPastedRedirect();
            } catch (e) {
                setAuthGateHint(`${e.message} Paste the link into the box manually.`);
                authInput.focus();
            }
        });
    }

    if (oauthGateBtn) {
        oauthGateBtn.addEventListener('click', openNintendoOAuth);
    }

    if (submitGateBtn) {
        submitGateBtn.addEventListener('click', () => {
            if (!requireNxapiConsent()) return;
            if (pendingRememberedResume && hasRememberedAccount()) {
                performFullAuthentication({ isResume: true });
                return;
            }
            const input = authInput?.value.trim() || '';
            performFullAuthentication({ input });
        });
    }

    if (profileForgetRememberedBtn) {
        profileForgetRememberedBtn.addEventListener('click', forgetRememberedAccount);
    }
}


