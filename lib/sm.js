'use strict';

var MAX_SEQ = Math.pow(2, 32);


function mod(v, n) {
    return ((v % n) + n) % n;
}


function StreamManagement(client) {
    this.client = client;
    this.id = false;
    this.allowResume = true;
    this.started = false;
    this.inboundStarted = false;
    this.outboundStarted = false;
    this.lastAck = 0;
    this.handled = 0;
    this.windowSize = 1;
    this.unacked = [];
    this.pendingAck = false;

    var NS = 'urn:xmpp:sm:3';
    this.stanzas = {
        Enable: client.stanzas.getDefinition('enable', NS),
        Resume: client.stanzas.getDefinition('resume', NS),
        Ack: client.stanzas.getDefinition('a', NS),
        Request: client.stanzas.getDefinition('r', NS),
        message: client.stanzas.getMessage(),
        presence: client.stanzas.getPresence(),
        iq: client.stanzas.getIq()
    };
}

StreamManagement.prototype = {
    constructor: {
        value: StreamManagement
    },
    sync: function (handlers) {
        this._saveState = handlers.persist;
        this._clearState = handlers.clear;
        
        var savedStream = handlers.restore();
        if (savedStream) {
            this.restore(savedStream);
        }
    },
    persist: function () {
        if (this._saveState) {
            this._saveState({
                jid: this.client.jid,
                id: this.id,
                lastAck: this.lastAck,
                handled: this.handled,
                queue: this.unacked
            });
        }
    },
    restore: function (data) {
        var self = this;

        if (!data.id || data.lastAck === undefined || data.handled === undefined) {
            return;
        }

        this.id = data.id;
        this.lastAck = data.lastAck;
        this.handled = data.handled;

        // Rehydrate the queue items back into stanza objects

        var queue = data.queue || [];
        var restoredQueue = queue.map(function (item) {
            var StanzaClass = self.stanzas[item.type];
            item.stanza = new StanzaClass(item.stanza);
            return item;
        });

        this.unacked = restoredQueue;
    },
    enable: function () {
        var enable = new this.stanzas.Enable();
        enable.resume = this.allowResume;
        this.client.send(enable);
        this.handled = 0;
        this.outboundStarted = true;
    },
    resume: function () {
        var resume = new this.stanzas.Resume({
            h: this.handled,
            previd: this.id
        });
        this.client.send(resume);
        this.outboundStarted = true;
    },
    enabled: function (resp) {
        this.id = resp.id;
        this.handled = 0;
        this.inboundStarted = true;
    },
    resumed: function (resp) {
        this.id = resp.previd;
        if (resp.h) {
            this.process(resp, true);
        }
        this.inboundStarted = true;
    },
    failed: function () {
        this.inboundStarted = false;
        this.outboundStarted = false;
        this.id = false;
        this.lastAck = 0;
        this.handled = 0;
        this.unacked = [];
        this._clearState();
    },
    ack: function () {
        this.client.send(new this.stanzas.Ack({
            h: this.handled
        }));
    },
    request: function () {
        this.pendingAck = true;
        this.client.send(new this.stanzas.Request());
    },
    process: function (ack, resend) {
        var self = this;
        var numAcked = mod(ack.h - this.lastAck, MAX_SEQ);

        this.pendingAck = false;

        for (var i = 0; i < numAcked && this.unacked.length > 0; i++) {
            var data = this.unacked.shift();
            this.client.emit('stanza:acked', data.stanza);
        }
        this.lastAck = ack.h;
        this.persist();

        if (resend) {
            var resendUnacked = this.unacked;
            this.unacked = [];
            resendUnacked.forEach(function (item) {
                self.client.send(item.stanza);
            });
        }

        if (this.needAck()) {
            this.request();
        }
    },
    track: function (stanza) {
        var name = stanza._name;
        var acceptable = {
            message: true,
            presence: true,
            iq: true
        };

        if (this.outboundStarted && acceptable[name]) {
            this.unacked.push({
                type: stanza._name,
                stanza: stanza
            });
            this.persist();
            if (this.needAck()) {
                this.request();
            }
        }
    },
    handle: function () {
        if (this.inboundStarted) {
            this.handled = mod(this.handled + 1, MAX_SEQ);
            this.persist();
        }
    },
    needAck: function () {
        return !this.pendingAck && this.unacked.length >= this.windowSize;
    }
};

Object.defineProperties(StreamManagement.prototype, {
    started: {
        get: function () {
            return this.outboundStarted && this.inboundStarted;
        },
        set: function (value) {
            if (!value) {
                this.outboundStarted = false;
                this.inboundStarted = false;
            }
        }
    }
});

module.exports = StreamManagement;
