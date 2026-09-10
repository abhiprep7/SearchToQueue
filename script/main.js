var DEFAULT_TOPIC = "onCommonSearch";
var MAX_LOG_ENTRIES = 100;

// Flat delay before publishing, giving Common Search time to finish loading and
// subscribe. The launcher link already carries dashboard:<id>/tabId:<id>, so this
// widget loads on the same tab as Common Search and publishes directly - no redirect
// hop needed. Set high enough to cover a "cold" first-in-session load (terms/legal
// acceptance, uncached assets), not just a warm reload - a fixed number can't tell
// the two apart, so it has to be sized for the slower case.
var DEFAULT_PUBLISH_DELAY_MS = 9000;
var PUBLISH_DELAY_PREF = "publishDelayMs";

// Topic the extracted drag-and-drop object(s) get published on, via the same PlatformAPI
// publish/subscribe already used for the Search Bridge feature below - no external broker,
// no new dependency, just another topic on the platform's own pub/sub bus. Any other
// widget/app on the same live dashboard session can subscribe to receive them. Not durable:
// if nothing is subscribed at the moment of the drop, that drop is simply gone.
var DEFAULT_DND_TOPIC = "onDroppedObjects";
var DND_TOPIC_PREF = "dndTopic";

// Optional, in addition to the PlatformAPI publish above: if an AMQ URL is configured, each
// dropped object is also POSTed there directly (e.g. ActiveMQ's REST Message API endpoint,
// full target including destination + query string, like
// http://host:8161/api/message/SEARCHBRIDGE.DND?type=queue). Left blank, this is skipped -
// the PlatformAPI publish above always happens either way.
var AMQ_URL_PREF = "amqUrl";
var AMQ_USERNAME_PREF = "amqUsername";
var AMQ_PASSWORD_PREF = "amqPassword";

var MyWidget = function() {
    var me = this;

    this.start = function() {
        var url = widget.getUrl();
        me.baseUrl = url.substring(0, url.lastIndexOf("/"));

        widget.addEvent("onLoad", me.onLoad);
        widget.addEvent("onRefresh", me.onRefresh);

        // DnD works on the widget's own document regardless of debug UI, so wire it here
        // rather than inside renderDebugUI.
        document.addEventListener("dragover", me.onDragOver);
        document.addEventListener("drop", me.onDrop);
    };

    this.getParams = function() {
        var merged = {};

        var search = window.location.search || "";
        if (search.length > 1) {
            search
                .substring(1)
                .split("&")
                .forEach(function(pair) {
                    var kv = pair.split("=");
                    if (kv.length === 2) {
                        merged[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
                    }
                });
        }

        var hash = window.location.hash || "";
        var hashParts = hash.replace(/^#/, "").split("&");
        for (var i = 1; i < hashParts.length; i++) {
            var pair = hashParts[i].split("=");
            if (pair.length === 2) {
                merged[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
            }
        }

        if (merged.widgetDomain) {
            var qIndex = merged.widgetDomain.indexOf("?");
            if (qIndex !== -1) {
                merged.widgetDomain
                    .substring(qIndex + 1)
                    .split("&")
                    .forEach(function(pair) {
                        var kv = pair.split("=");
                        if (kv.length === 2 && !(kv[0] in merged)) {
                            merged[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
                        }
                    });
            }
        }

        return merged;
    };

    this.setStatus = function(el, kind, text) {
        if (!el) {
            return;
        }
        el.className = "status" + (kind ? " " + kind : "");
        el.textContent = text;
    };

    this.appendLog = function(logEl, topic, payload) {
        var emptyEl = logEl.querySelector(".log-empty");
        if (emptyEl) {
            emptyEl.remove();
        }

        var entry = document.createElement("div");
        entry.className = "log-entry";

        var time = new Date().toLocaleTimeString();
        var payloadText;
        try {
            payloadText = JSON.stringify(payload);
        } catch (err) {
            payloadText = String(payload);
        }

        entry.innerHTML = "[" + time + "] <span class='log-topic'>" + topic + "</span> = " + payloadText;
        logEl.insertBefore(entry, logEl.firstChild);

        while (logEl.children.length > MAX_LOG_ENTRIES) {
            logEl.removeChild(logEl.lastChild);
        }
    };

    this.parseValue = function(rawValue) {
        try {
            return JSON.parse(rawValue);
        } catch (err) {
            return rawValue;
        }
    };

    this.extractSearchValue = function(rawValue) {
        if (!rawValue) {
            return "";
        }
        var trimmed = rawValue.trim();
        if (trimmed.charAt(0) === "{") {
            try {
                var parsed = JSON.parse(trimmed);
                if (parsed && parsed.data && typeof parsed.data.commonsearchname !== "undefined") {
                    return parsed.data.commonsearchname;
                }
            } catch (err) {
                // not valid JSON, fall through and use it as a plain string
            }
        }
        return rawValue;
    };

    // Pulls the physicalId (objectId) / serviceId pairs out of a dropped 3DXContent
    // payload. data.items is an array, so a single drop can carry multiple objects.
    this.extractDroppedItems = function(rawValue) {
        var parsed;
        try {
            parsed = JSON.parse(rawValue);
        } catch (err) {
            me.debugWarn("Search Bridge: drop payload was not valid JSON.", rawValue, err);
            return [];
        }

        if (!parsed || parsed.protocol !== "3DXContent" || !parsed.data) {
            me.debugWarn("Search Bridge: drop payload was not a recognized 3DXContent message.", parsed);
            return [];
        }

        var items = parsed.data.items || [];
        if (!Array.isArray(items)) {
            items = [items];
        }

        return items
            .filter(function(item) {
                return item && item.objectId && item.serviceId;
            })
            .map(function(item) {
                return {
                    physicalId: item.objectId,
                    serviceId: item.serviceId,
                    envId: item.envId,
                    objectType: item.objectType
                };
            });
    };

    this.onDragOver = function(e) {
        // Required so the browser allows a drop to happen at all.
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "copy";
        }
    };

    this.onDrop = function(e) {
        e.preventDefault();

        // A real 3DX drag source carries the payload as text data (no File involved), but
        // dragging an actual .json file in from the OS file system arrives as dataTransfer.files
        // instead - handle both.
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
            me.handleDroppedFiles(e.dataTransfer.files);
            return;
        }

        var raw = "";
        if (e.dataTransfer) {
            raw = e.dataTransfer.getData("text/plain") ||
                e.dataTransfer.getData("Text") ||
                e.dataTransfer.getData("application/json") ||
                "";
        }

        me.debugLog("Search Bridge: drop payload raw", raw);

        var items = me.extractDroppedItems(raw);
        if (!items.length) {
            return;
        }

        me.debugLog("Search Bridge: extracted dropped items", items);
        me.dispatchDroppedItems(items);
    };

    // Reads one or more dropped .json files (each expected to contain a single 3DXContent
    // payload) and merges the extracted items from all of them into a single publish.
    this.handleDroppedFiles = function(fileList) {
        var files = Array.prototype.slice.call(fileList);
        var pending = files.length;
        var allItems = [];

        files.forEach(function(file) {
            var reader = new FileReader();
            reader.onload = function() {
                var items = me.extractDroppedItems(String(reader.result));
                if (items.length) {
                    me.debugLog("Search Bridge: extracted items from file", file.name, items);
                    allItems = allItems.concat(items);
                } else {
                    me.debugWarn("Search Bridge: file did not contain a recognizable 3DXContent payload", file.name);
                }
                pending--;
                if (pending === 0 && allItems.length) {
                    me.dispatchDroppedItems(allItems);
                }
            };
            reader.onerror = function() {
                me.debugWarn("Search Bridge: failed to read dropped file", file.name, reader.error);
                pending--;
            };
            reader.readAsText(file);
        });
    };

    // Publishes the extracted { physicalId, serviceId, ... } objects on the platform's own
    // pub/sub bus (same PlatformAPI used for Search Bridge below) - any other widget/app on
    // the same live dashboard session that's subscribed to this topic receives them.
    this.publishDroppedItems = function(items) {
        var topic = widget.getValue(DND_TOPIC_PREF) || DEFAULT_DND_TOPIC;
        me.sendMessage(topic, { data: { items: items } }, null);
    };

    // Pushes each extracted object straight to AMQ (e.g. ActiveMQ's REST Message API), one
    // POST per item. Only runs if amqUrl is configured; otherwise a no-op.
    this.pushToAmq = function(items) {
        var url = widget.getValue(AMQ_URL_PREF);
        if (!url) {
            return;
        }

        var headers = { "Content-Type": "application/json" };
        var username = widget.getValue(AMQ_USERNAME_PREF);
        if (username) {
            var password = widget.getValue(AMQ_PASSWORD_PREF) || "";
            headers.Authorization = "Basic " + btoa(username + ":" + password);
        }

        items.forEach(function(item) {
            fetch(url, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(item)
            })
                .then(function(res) {
                    if (!res.ok) {
                        throw new Error("HTTP " + res.status);
                    }
                    me.debugLog("Search Bridge: pushed to AMQ", item);
                })
                .catch(function(err) {
                    me.debugWarn("Search Bridge: AMQ push failed", item, err);
                });
        });
    };

    // Always publishes via PlatformAPI; additionally pushes to AMQ if amqUrl is configured.
    this.dispatchDroppedItems = function(items) {
        me.publishDroppedItems(items);
        me.pushToAmq(items);
    };

    this.debugLog = function() {
        if (me.debug) {
            console.log.apply(console, arguments);
        }
    };

    this.debugWarn = function() {
        if (me.debug) {
            console.warn.apply(console, arguments);
        }
    };

    this.redirectTo = function(url, statusEl) {
        if (!url) {
            me.setStatus(statusEl, "failure", "Target base URL is required.");
            return;
        }

        try {
            (window.top || window).location.href = url;
            me.setStatus(statusEl, "info", "Redirecting top-level tab to " + url + " ...");
        } catch (err) {
            console.warn("Search Bridge: could not navigate top-level tab, falling back to iframe-only navigation.", err);
            me.setStatus(statusEl, "failure", "Blocked from navigating the top-level tab (" + err.message + "). Falling back to navigating this widget's own iframe only.");
            window.location.href = url;
        }
    };

    this.getPublishDelayMs = function() {
        var value = parseInt(widget.getValue(PUBLISH_DELAY_PREF), 10);
        return isNaN(value) ? DEFAULT_PUBLISH_DELAY_MS : value;
    };

    this.onLoad = function() {
        widget.setIcon(me.baseUrl + "/assets/icons/default-widget-icon.png");
        widget.setTitle("Search Bridge");

        widget.addPreference({
            name: PUBLISH_DELAY_PREF,
            type: "text",
            label: "Publish delay on landing (ms)",
            defaultValue: String(DEFAULT_PUBLISH_DELAY_MS)
        });

        widget.addPreference({
            name: DND_TOPIC_PREF,
            type: "text",
            label: "PlatformAPI topic to publish drag-and-drop objects on",
            defaultValue: DEFAULT_DND_TOPIC
        });

        widget.addPreference({
            name: AMQ_URL_PREF,
            type: "text",
            label: "AMQ URL to also push dropped objects to (optional, e.g. ActiveMQ REST Message API endpoint incl. destination + query string)",
            defaultValue: ""
        });

        widget.addPreference({
            name: AMQ_USERNAME_PREF,
            type: "text",
            label: "AMQ username (leave blank if not required)",
            defaultValue: ""
        });

        widget.addPreference({
            name: AMQ_PASSWORD_PREF,
            type: "text",
            label: "AMQ password (leave blank if not required)",
            defaultValue: ""
        });

        var params = me.getParams();
        me.debug = params.debug === "1";

        me.debugLog("Search Bridge iframe location:", {
            href: window.location.href,
            search: window.location.search,
            hash: window.location.hash
        });

        var searchValue = me.extractSearchValue(params.csn || params.commonsearchname || "");
        var topic = params.topic || DEFAULT_TOPIC;

        if (searchValue) {
            // The launcher link already carries dashboard:<id>/tabId:<id>, so this load is
            // already on the same tab as Common Search - no redirect hop needed, just wait
            // for it to finish loading/subscribing, then publish directly.
            setTimeout(function() {
                me.sendMessage(topic, { data: { commonsearchname: searchValue } }, null);
            }, me.getPublishDelayMs());
            return;
        }

        if (me.debug) {
            me.renderDebugUI(params, searchValue);
        }
        // else: nothing to do and no "?debug=1" - stay blank, no visible toggle.
    };

    this.renderDebugUI = function(params, searchValue) {
        var content = document.querySelector("div#content");
        content.innerHTML = `
            <div class="card">
                <h1>Search bridge (URL &rarr; PlatformAPI publish)</h1>
                <div id="auto-status" class="status"></div>

                <h2>Manual publish (test different topics)</h2>
                <label for="topic">Topic</label>
                <input id="topic" type="text" autocomplete="off" />

                <label for="value">Value</label>
                <input id="value" type="text" autocomplete="off" />

                <button id="publish-btn" type="button">Publish</button>
                <div id="manual-status" class="status"></div>
            </div>

            <div class="card">
                <h2>Redirect test</h2>
                <p class="hint">
                    Tests whether this widget's iframe can navigate the whole browser tab at all
                    (some platforms sandbox widget iframes without top-level navigation
                    permission). Independent of how the search value gets in.
                </p>
                <label for="redirect-target">Target URL</label>
                <input id="redirect-target" type="text" autocomplete="off" placeholder="https://example.com" />

                <button id="redirect-btn" type="button">Redirect</button>
                <div id="redirect-status" class="status"></div>
            </div>

            <div class="card">
                <h2>Live message log (subscribed to "*")</h2>
                <p class="hint">Drag-and-drop pushes land here too, on the "${DEFAULT_DND_TOPIC}" topic (or your configured dndTopic preference).</p>
                <button id="clear-log-btn" type="button" class="secondary">Clear log</button>
                <div class="log" id="log">
                    <div class="log-empty">No messages yet.</div>
                </div>
            </div>`;

        var topicInput = document.getElementById("topic");
        var valueInput = document.getElementById("value");
        var publishBtn = document.getElementById("publish-btn");
        var clearLogBtn = document.getElementById("clear-log-btn");
        var autoStatus = document.getElementById("auto-status");
        var manualStatus = document.getElementById("manual-status");
        var log = document.getElementById("log");
        var redirectTargetInput = document.getElementById("redirect-target");
        var redirectBtn = document.getElementById("redirect-btn");
        var redirectStatus = document.getElementById("redirect-status");

        var topic = params.topic || DEFAULT_TOPIC;

        topicInput.value = topic;
        valueInput.value = JSON.stringify({ data: { commonsearchname: searchValue || "nv-100" } });

        me.setStatus(autoStatus, "info", 'No "csn" param found in the URL — nothing auto-published.');

        publishBtn.addEventListener("click", function() {
            me.sendMessage(topicInput.value.trim(), me.parseValue(valueInput.value), manualStatus);
        });

        clearLogBtn.addEventListener("click", function() {
            log.innerHTML = "";
            var emptyEl = document.createElement("div");
            emptyEl.className = "log-empty";
            emptyEl.textContent = "No messages yet.";
            log.appendChild(emptyEl);
        });

        redirectBtn.addEventListener("click", function() {
            me.redirectTo(redirectTargetInput.value.trim(), redirectStatus);
        });

        me.listenMessage("*", function(messageBody, fullMessage) {
            me.appendLog(log, fullMessage.topic, messageBody);
        });
    };

    this.onRefresh = function() {};

    this.sendMessage = function(topic, data, statusEl, onDone) {
        if (!topic) {
            me.setStatus(statusEl, "failure", "Topic is required.");
            if (onDone) {
                onDone();
            }
            return;
        }

        require(["DS/PlatformAPI/PlatformAPI"], function(PlatformAPI) {
            try {
                PlatformAPI.publish(topic, data);
                me.debugLog("Search Bridge: published", { topic: topic, data: data });
                me.setStatus(statusEl, "success", 'Published "' + topic + '" = ' + JSON.stringify(data) + ".");
            } catch (err) {
                me.debugWarn("Search Bridge: publish failed", { topic: topic, data: data, err: err });
                me.setStatus(statusEl, "failure", "Publish failed: " + err.message);
            }
            if (onDone) {
                onDone();
            }
        });
    };

    this.listenMessage = function(topic, callback) {
        require(["DS/PlatformAPI/PlatformAPI"], function(PlatformAPI) {
            PlatformAPI.subscribe(topic, callback);
        });
    };
};

function waitFor(globalVarname, timeout, callback) {
    if (typeof window[globalVarname] !== "undefined") {
        callback();
    } else if (timeout === 0) {
        document.body.innerHTML = "Error while trying to load widget. See console for details";
        throw globalVarname + " didn't load";
    } else {
        var dt = 100;
        setTimeout(waitFor, dt, globalVarname, timeout - dt, callback);
    }
}

waitFor("widget", 1000, function() {
    var myWidget = new MyWidget();
    myWidget.start();
});
