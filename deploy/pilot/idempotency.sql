-- Additive, run once as the local database administrator before deploying Phase 2.
-- Retain request tombstones: deleting them would permit an old ID to send again.
CREATE TABLE IF NOT EXISTS PilotSendRequest (
    clientMessageId VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    payloadDigest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('PROCESSING','SENT','UNKNOWN') NOT NULL,
    providerId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX PilotSendRequest_status (status)
);
