// Generic Driver.js tour engine — app-agnostic (see DataCentralEmbedOnboardingTours.md §5.4).
// Requires driver.js 1.8+ (window.driver.js.driver) and its CSS to be loaded first.
// Blazor apps: tourEngine.init(payload, dotnetRef). Other apps: tourEngine.init({...payload,
// callbacks: { onProgress(...), navigate(route) }}).
window.tourEngine = (function () {
    'use strict';

    let cfg = null;      // { tours, strings, callbacks }
    let active = null;   // { key, version, stepCount, obj, finished, everHighlighted }

    function byKey(key) { return cfg ? (cfg.tours || []).find(function (t) { return t.key === key; }) : null; }

    function report(status, stepIndex) {
        if (!cfg || !active) return;
        try { cfg.callbacks.onProgress(active.key, active.version, stepIndex, active.stepCount, status); }
        catch (e) { /* progress reporting must never break the tour */ }
    }

    // First VISIBLE match for the selector, or undefined so driver's waitForElement/
    // skipMissingElement logic engages. Plain selectors would take the first DOM match,
    // which may be a display:none duplicate (e.g. a mobile-layout twin of a desktop
    // control) — driver highlights hidden elements as broken 0x0 rects.
    function resolveVisible(selector) {
        var els = document.querySelectorAll(selector);
        for (var i = 0; i < els.length; i++) {
            if (els[i].getClientRects().length > 0) return els[i];
        }
        return undefined;
    }

    function toDriverSteps(tour) {
        return tour.steps.map(function (s) {
            return {
                element: s.element ? function () { return resolveVisible(s.element); } : undefined,
                advanceOnClick: !!s.advanceOnClick,
                popover: {
                    title: s.title || undefined,
                    description: s.description || undefined,
                    side: s.side || 'bottom',
                    align: s.align || 'start'
                }
            };
        });
    }

    // The route "in effect" at a step is the nearest route declared at or before it —
    // so resuming/deep-linking into the middle of a tour still lands on the right page.
    function effectiveRoute(tour, index) {
        for (var i = Math.min(index, tour.steps.length - 1); i >= 0; i--) {
            if (tour.steps[i].route) return tour.steps[i].route;
        }
        return null;
    }

    function navigateForStep(tour, index) {
        var route = effectiveRoute(tour, index);
        if (!route || window.location.pathname === route) return Promise.resolve();
        return Promise.resolve(cfg.callbacks.navigate(route));
    }

    function stop() {
        if (!active) return;
        active.finished = true;   // silent teardown: no Dismissed report
        try { active.obj.destroy(); } catch (e) { }
        active = null;
    }

    function start(key, atStep) {
        if (!cfg) return;
        var tour = byKey(key);
        if (!tour || !tour.steps.length) return;
        stop();
        var startAt = Math.min(Math.max(atStep || 0, 0), tour.steps.length - 1);
        var obj = window.driver.js.driver({
            steps: toDriverSteps(tour),
            showProgress: tour.steps.length > 1,
            progressText: cfg.strings.progress,
            nextBtnText: cfg.strings.next,
            prevBtnText: cfg.strings.previous,
            doneBtnText: cfg.strings.done,
            waitForElement: 5000,          // Blazor/SPA renders async — wait for anchors
            skipMissingElement: true,      // a missing anchor skips the step, never strands
            popoverClass: 'app-tour',
            overlayOpacity: 0.6,
            onNextClick: function () {
                var next = obj.getActiveIndex() + 1;
                if (next < tour.steps.length) {
                    navigateForStep(tour, next).then(function () { obj.moveNext(); });
                } else {
                    obj.moveNext();
                }
            },
            onPrevClick: function () {
                var prev = obj.getActiveIndex() - 1;
                if (prev >= 0) {
                    navigateForStep(tour, prev).then(function () { obj.movePrevious(); });
                } else {
                    obj.movePrevious();
                }
            },
            onDoneClick: function () {
                // With skipMissingElement, driver labels a step "Done" when the REMAINING
                // steps' anchors aren't on the current page — which is exactly the state
                // before a mid-tour route hop. Only complete on the true last step;
                // otherwise treat the click as "next" and navigate.
                var next = obj.getActiveIndex() + 1;
                if (next < tour.steps.length) {
                    navigateForStep(tour, next).then(function () { obj.moveNext(); });
                    return;
                }
                if (active) active.finished = true;
                report('Completed', tour.steps.length - 1);
                obj.destroy();
            },
            onHighlighted: function (el, step, opts) {
                if (active && !active.finished && typeof opts.index === 'number') {
                    active.everHighlighted = true;
                    report('InProgress', opts.index);
                }
            },
            onDestroyStarted: function () {
                if (active && !active.finished) {
                    active.finished = true;
                    // a tour torn down before any step was shown is not a user dismissal
                    if (active.everHighlighted) {
                        var idx = obj.getActiveIndex();
                        report('Dismissed', typeof idx === 'number' ? idx : 0);
                    }
                }
                obj.destroy();
                active = null;   // driver skips onDestroyed when nothing was highlighted
            },
            onDestroyed: function () { active = null; }
        });
        active = { key: key, version: tour.version, stepCount: tour.steps.length, obj: obj, finished: false, everHighlighted: false };
        navigateForStep(tour, startAt).then(function () { obj.drive(startAt); });
    }

    return {
        init: function (payload, dotnetRef) {
            stop();
            cfg = {
                tours: payload.tours || [],
                strings: payload.strings || { next: 'Next', previous: 'Previous', done: 'Done', progress: '{{current}} / {{total}}' },
                callbacks: dotnetRef ? {
                    onProgress: function (key, version, stepIndex, stepCount, status) {
                        dotnetRef.invokeMethodAsync('OnTourProgress', key, version, stepIndex, stepCount, status);
                    },
                    navigate: function (route) { return dotnetRef.invokeMethodAsync('NavigateTo', route); }
                } : (payload.callbacks || { onProgress: function () { }, navigate: function () { return Promise.resolve(); } })
            };
            // deep link (?tour=key — reminder emails) beats auto-start; consume the
            // parameter so a later reload doesn't restart the tour
            var requested = new URLSearchParams(window.location.search).get('tour');
            var deepLink = requested ? byKey(requested) : null;
            if (deepLink) {
                try {
                    var url = new URL(window.location.href);
                    url.searchParams.delete('tour');
                    history.replaceState(null, '', url.pathname + url.search + url.hash);
                } catch (e) { }
                start(deepLink.key, deepLink.resumeAt || 0);
                return;
            }
            var auto = cfg.tours.find(function (t) { return t.autoStart; });
            if (auto) start(auto.key, 0);
        },
        start: start,
        resume: function (key) {
            var tour = byKey(key);
            start(key, tour && tour.resumeAt ? tour.resumeAt : 0);
        },
        stop: stop,
        active: function () { return active ? active.key : null; },
        highlight: function (selector, title, description) {
            window.driver.js.driver({ popoverClass: 'app-tour' })
                .highlight({ element: function () { return resolveVisible(selector); }, popover: { title: title, description: description } });
        }
    };
})();
