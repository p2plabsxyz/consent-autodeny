import ConsentEngine from "./ConsentEngine.js";

export default class Tools {
    static setBase(base) {
        Tools.base = base;
    }

    static getBase() {
        return Tools.base;
    }

    // While the engine looks for a CMP it asks the same couple of hundred
    // selectors every half second. Once a page has settled the answers stay
    // the same, so they are kept until a mutation says something changed.
    static startWatching() {
        if (Tools.watcher != null) {
            return;
        }

        let watcher = {
            documentAnswers: new Map(),
            roots: null,
            rootsFoundAt: 0,
            watchedRoots: new WeakSet(),
            watchedRootCount: 0,
            rootHasMatch: new Map()
        };
        watcher.observer = new MutationObserver((records) => {
            Tools.noteMutations(records);
        });
        watcher.observer.observe(document, Tools.watchOptions);
        Tools.watcher = watcher;
    }

    static stopWatching() {
        if (Tools.watcher != null) {
            Tools.watcher.observer.disconnect();
            Tools.watcher = null;
        }
    }

    static noteMutations(records) {
        let watcher = Tools.watcher;
        if (watcher == null || records.length === 0) {
            return;
        }
        if (watcher.watchedRootCount === 0) {
            // Only the document is watched, so every record is from it
            watcher.documentAnswers.clear();
            return;
        }
        for (let record of records) {
            let root = record.target.getRootNode();
            if (root === document) {
                watcher.documentAnswers.clear();
            } else {
                watcher.rootHasMatch.delete(root);
            }
        }
    }

    // Runs one detection pass. Mutations not yet delivered are taken first,
    // so an answer is never reused after the page changed.
    static duringPass(callback) {
        if (Tools.watcher != null) {
            Tools.noteMutations(Tools.watcher.observer.takeRecords());
        }

        Tools.inPass = true;
        Tools.pass = {
            roots: null,
            candidates: null
        };
        try {
            return callback();
        } finally {
            Tools.inPass = false;
            Tools.pass = null;
        }
    }

    // The page's open shadow roots, nested ones too. Only elements that have a
    // shadow root are entered.
    static openShadowRoots() {
        let scopes = [document];
        for (let i = 0; i < scopes.length; i++) {
            for (let element of scopes[i].querySelectorAll("*")) {
                if (element.shadowRoot != null) {
                    scopes.push(element.shadowRoot);
                }
            }
        }
        return scopes.slice(1);
    }

    // The shadow roots found by the last look, which is done again every two
    // seconds: a custom element can get its shadow root long after it was
    // added, and no mutation says so. Every root found is watched for
    // changes from then on.
    static watchedShadowRoots() {
        let watcher = Tools.watcher;
        let now = Date.now();
        if (watcher.roots == null || now - watcher.rootsFoundAt >= 2000) {
            watcher.roots = Tools.openShadowRoots();
            watcher.rootsFoundAt = now;
            for (let root of watcher.roots) {
                if (!watcher.watchedRoots.has(root)) {
                    watcher.watchedRoots.add(root);
                    watcher.watchedRootCount++;
                    watcher.observer.observe(root, Tools.watchOptions);
                }
            }
        }
        return watcher.roots.filter((root) => {
            return root.host.isConnected;
        });
    }

    // Selectors the engine asks the document for in each pass. Pages can have
    // a thousand shadow roots (Reddit), so a root is asked about all of these
    // in one query, and only a root with a match is asked about each one.
    static addKnownSelectors(selectors) {
        for (let selector of selectors) {
            if (typeof selector !== "string" || selector.includes(":scope") || Tools.knownSelectors.has(selector)) {
                continue;
            }
            try {
                document.createDocumentFragment().querySelector(selector);
            } catch (e) {
                continue;
            }
            Tools.knownSelectors.add(selector);
            Tools.selectorUnion = null;
        }
    }

    // The shadow roots worth asking for this selector. Outside a detection
    // pass (actions, the showing check) every open shadow root is asked.
    static shadowRootsFor(selector) {
        let watcher = Tools.watcher;
        if (!Tools.inPass || watcher == null) {
            return Tools.openShadowRoots();
        }

        let pass = Tools.pass;
        if (pass.roots == null) {
            pass.roots = Tools.watchedShadowRoots();
        }
        if (pass.roots.length === 0) {
            return pass.roots;
        }

        if (!Tools.knownSelectors.has(selector)) {
            // Not in the shared query yet: ask every root this time
            Tools.addKnownSelectors([selector]);
            return pass.roots;
        }

        if (Tools.selectorUnion == null) {
            Tools.selectorUnion = Array.from(Tools.knownSelectors).join(",");
        }
        let union = Tools.selectorUnion;
        if (pass.candidates == null || pass.candidatesUnion !== union) {
            pass.candidatesUnion = union;
            pass.candidates = pass.roots.filter((root) => {
                let known = watcher.rootHasMatch.get(root);
                if (known == null || known.union !== union) {
                    known = {
                        union: union,
                        match: root.querySelector(union) != null
                    };
                    watcher.rootHasMatch.set(root, known);
                }
                return known.match;
            });
        }
        return pass.candidates;
    }

    // document.querySelectorAll(selector), from an earlier pass when nothing
    // changed since. Filters still run on every call. A selector whose
    // matches can change without a mutation (:hover, :checked) is always
    // asked again.
    static queryDocument(selector) {
        let watcher = Tools.watcher;
        if (!Tools.inPass || watcher == null || !Tools.isStructural(selector)) {
            return Array.from(document.querySelectorAll(selector));
        }

        let answer = watcher.documentAnswers.get(selector);
        if (answer == null) {
            answer = Array.from(document.querySelectorAll(selector));
            watcher.documentAnswers.set(selector, answer);
        }
        return answer.slice();
    }

    static isStructural(selector) {
        let structural = Tools.structuralSelectors.get(selector);
        if (structural == null) {
            let bare = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "").replace(/\[[^\]]*\]/g, "");
            structural = (bare.match(/:[\w-]+/g) || []).every((pseudo) => {
                return Tools.structuralPseudoClasses.has(pseudo.toLowerCase());
            });
            Tools.structuralSelectors.set(selector, structural);
        }
        return structural;
    }

    static findElement(options, parent = null, multiple = false) {
        let possibleTargets = null;
        let searchedDocument = false;

        if(options.selector.trim() === ":scope") {
            //Select current root
            if(parent != null) {
                possibleTargets = [parent];
            } else {
                if (Tools.base != null) {
                    possibleTargets = [Tools.base];
                } else {
                    possibleTargets = [document];
                }

            }

            if(ConsentEngine.debugValues.debugRules) {
                console.log("Special :scope handling, selecting current root:", possibleTargets);
            }
        } else {
    	    // Find the right point to start from
            let top = document;
            if (parent != null) {
                top = parent;
            } else if (Tools.base != null){
                top = Tools.base;
            }

    	    // Consider shadow roots, even closed ones
            if (top.shadowRoot){
                top = top.shadowRoot;
            } else if (top.openOrClosedShadowRoot){ // Firefox
    	        top = top.openOrClosedShadowRoot;
            } else if (top instanceof HTMLElement && chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot(top)){ // Chromium
    	        top = chrome.dom.openOrClosedShadowRoot(top);
            }
            if (top === document) {
                possibleTargets = Tools.queryDocument(options.selector);
                searchedDocument = true;
            } else {
                possibleTargets = Array.from(top.querySelectorAll(options.selector));
            }
        }

        const clonedPossibleTargets = possibleTargets.slice();

        if (options.textFilter != null) {
            let filterMultipleSpacesRegex = /\s{2,}/gm;

            possibleTargets = possibleTargets.filter((possibleTarget) => {
                let textContent = possibleTarget.textContent.toLowerCase().replace(filterMultipleSpacesRegex, " ");

                if (Array.isArray(options.textFilter)) {
                    let foundText = false;

                    for (let text of options.textFilter) {
                        if (textContent.indexOf(text.toLowerCase().replace(filterMultipleSpacesRegex, " ")) !== -1) {
                            foundText = true;
                            break;
                        }
                    }

                    return foundText;
                } else if (options.textFilter != null) {
                    return textContent.indexOf(options.textFilter.toLowerCase()) !== -1;
                }
            });
        }

        if (options.styleFilters != null) {
            possibleTargets = possibleTargets.filter((possibleTarget) => {
                let styles = window.getComputedStyle(possibleTarget);

                let keep = true;

                for (let styleFilter of options.styleFilters) {
                    let option = styles[styleFilter.option]

                    if (styleFilter.negated) {
                        keep = keep && (option !== styleFilter.value);
                    } else {
                        keep = keep && (option === styleFilter.value);
                    }
                }

                return keep;
            });
        }

        if (options.displayFilter != null) {
            possibleTargets = possibleTargets.filter((possibleTarget) => {
                if(possibleTarget.matches(".ConsentOMatic-CMP-NoDetect")) {
                    return !options.displayFilter;
                }

                if(options.displayFilter) {
                    //We should be displayed
                    return possibleTarget.offsetHeight !== 0;
                } else {
                    //We should not be displayed
                    return possibleTarget.offsetHeight === 0;
                }
            });
        }

        if (options.iframeFilter != null) {
            possibleTargets = possibleTargets.filter((possibleTarget) => {
                if(options.iframeFilter) {
                    //We should be inside an iframe
                    return window.location !== window.parent.location;
                } else {
                    //We should not be inside an iframe
                    return window.location === window.parent.location;
                }
            });
        }

        if(options.childFilter != null) {
            possibleTargets = possibleTargets.filter((possibleTarget) => {
                let oldBase = Tools.base;
                Tools.setBase(possibleTarget);
                let childResults = Tools.find(options.childFilter);
                Tools.setBase(oldBase);
                if(options.childFilterNegated) {
                    return childResults.target == null;
                } else {
                    return childResults.target != null;
                }
            });
        }

        // Some pages draw their consent dialog inside a web component's open
        // shadow root (Bandcamp's <page-footer> and <menu-bar>), which a query
        // on the document never reaches. Only when the document itself has no
        // match, ask the open shadow roots too.
        if (searchedDocument && possibleTargets.length === 0) {
            for (let root of Tools.shadowRootsFor(options.selector)) {
                possibleTargets.push(...Tools.findElement(options, root, true));
            }
        }

        if(ConsentEngine.debugValues.debugRules) {
            console.groupCollapsed("findElement:", options.selector, possibleTargets.length);
            console.log("Options:", options, "Parent:", parent);
            console.log("Possible targets before filter: ", clonedPossibleTargets);
            console.log("Possible targets after filter: ", possibleTargets);
            console.log("Returned result:", multiple?possibleTargets:possibleTargets[0]);
            console.groupEnd();
        }

        if (multiple) {
            return possibleTargets;
        } else {
            if (possibleTargets.length > 1) {
                if(ConsentEngine.debugValues.debugLog) {
                    console.warn("Multiple possible targets: ", possibleTargets, options, parent);
                }
            }

            return possibleTargets[0];
        }
    }

    static find(options, multiple = false) {
        let results = [];
        if (options.parent != null) {
            let parent = Tools.findElement(options.parent, null, multiple);
            if (parent != null) {
                if (parent instanceof Array) {
                    parent.forEach((p) => {
                        let targets = Tools.findElement(options.target, p, multiple);
                        if (targets instanceof Array) {
                            targets.forEach((target) => {
                                results.push({
                                    "parent": p,
                                    "target": target
                                });
                            });
                        } else {
                            results.push({
                                "parent": p,
                                "target": targets
                            });
                        }
                    });

                    return results;
                } else {
                    let targets = Tools.findElement(options.target, parent, multiple);
                    if (targets instanceof Array) {
                        targets.forEach((target) => {
                            results.push({
                                "parent": parent,
                                "target": target
                            });
                        });
                    } else {
                        results.push({
                            "parent": parent,
                            "target": targets
                        });
                    }
                }
            }
        } else {
            let targets = Tools.findElement(options.target, null, multiple);
            if (targets instanceof Array) {
                targets.forEach((target) => {
                    results.push({
                        "parent": null,
                        "target": target
                    });
                });
            } else {
                results.push({
                    "parent": null,
                    "target": targets
                });
            }
        }

        if (results.length === 0) {
            results.push({
                "parent": null,
                "target": null
            });
        }

        if (multiple) {
            return results;
        } else {
            if (results.length !== 1) {
                console.warn("Multiple results found, even though multiple false", results);
            }

            return results[0];
        }
    }
}

Tools.base = null;
Tools.watcher = null;
Tools.watchOptions = {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true
};
Tools.inPass = false;
Tools.pass = null;
Tools.knownSelectors = new Set();
Tools.selectorUnion = null;
Tools.structuralSelectors = new Map();
// Pseudo-classes that depend only on the DOM tree, so a mutation shows when
// their matches change.
Tools.structuralPseudoClasses = new Set([
    ":not", ":is", ":where", ":has", ":root", ":scope", ":empty",
    ":first-child", ":last-child", ":only-child",
    ":first-of-type", ":last-of-type", ":only-of-type",
    ":nth-child", ":nth-last-child", ":nth-of-type", ":nth-last-of-type"
]);
