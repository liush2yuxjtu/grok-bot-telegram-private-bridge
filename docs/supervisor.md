# Supervisor behavior

`bin/supervise.sh` restarts the Node process after a crash. Restart delays grow from 1 second to 30 seconds. `bin/stop` sends `TERM` to the process group and does not restart it.

## Control commands

```bash
bin/start
bin/status
bin/stop
```

The token stays in the file selected by `TELEGRAM_TOKEN_FILE`. The default is `secrets/token` under the repository. The file must be a regular, non-symlink file with mode `0600`.

## VM restart limit

Grok Bot cloud computer images observed during development had no working user-level systemd, cron, s6, runit, or desktop autostart path. The wrapper recovers a crashed bridge process, but it cannot guarantee startup after the entire VM or pod restarts.

After a Grok Bot computer restart, run:

```bash
bin/start
```

The `systemd/` unit is an example for environments that provide a working user-level systemd. It is not used by the observed Grok Bot image.
