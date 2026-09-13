#!/usr/bin/env python3
"""Run monitor-transfer assertions in a private, bounded two-monitor Shell."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import zipfile


def main():
    repository = Path(__file__).resolve().parents[1]
    uuid = 'ohno-scroller@ohnoibrokeit.dev'
    subprocess.run(['make', 'pack'], cwd=repository, check=True, timeout=30)
    with tempfile.TemporaryDirectory(prefix='ohno-scroller-monitor-') as temporary:
        root = Path(temporary)
        destination = root / 'data/gnome-shell/extensions' / uuid
        with zipfile.ZipFile(repository / f'{uuid}.shell-extension.zip') as archive:
            archive.extractall(destination)
        subprocess.run(['glib-compile-schemas', str(destination / 'schemas')], check=True, timeout=10)
        settings = root / 'config/glib-2.0/settings/keyfile'
        settings.parent.mkdir(parents=True)
        settings.write_text(
            f"[org/gnome/shell]\nenabled-extensions=['{uuid}']\n"
            '[org/gnome/mutter]\nworkspaces-only-on-primary=false\n'
            '[dev/ohnoibrokeit/gnome-shell/extensions/ohno-scroller]\n'
            "default-layout-mode='scrolling'\nanimation-duration=0\n"
        )
        environment = dict(os.environ,
            XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
            XDG_CACHE_HOME=str(root / 'cache'), XDG_STATE_HOME=str(root / 'state'),
            GSETTINGS_BACKEND='keyfile',
            MUTTER_WM_CLASS_FILTER='Gnome-shell-perf-helper',
            SHELL_BACKGROUND_IMAGE='/usr/share/gnome-shell/perf-background.xml')
        process = subprocess.Popen([
            'dbus-run-session', '--', 'gnome-shell', '--headless',
            '--virtual-monitor', '1280x720', '--virtual-monitor', '1280x720',
            '--wayland-display', f'ohno-scroller-monitor-{os.getpid()}',
            '--automation-script', str(repository / 'tests/automation/monitor-transfer.js'),
        ], env=environment, start_new_session=True)
        try:
            result = process.wait(timeout=60)
            if result:
                raise subprocess.CalledProcessError(result, process.args)
        finally:
            # Own the entire private process group, including helpers whose
            # D-Bus leader may already have exited. Never touch the live Shell.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


if __name__ == '__main__':
    main()
