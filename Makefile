UUID := ohno-scroller@ohnoibrokeit.dev
ZIP := $(UUID).shell-extension.zip
SCHEMA := schemas/dev.ohnoibrokeit.gnome-shell.extensions.ohno-scroller.gschema.xml

.PHONY: pack test test-animation test-preferences test-optional-settings test-monitor-transfer clean

pack:
	gnome-extensions pack --force --schema=$(SCHEMA) --extra-source=optionalBarSettings.js .

test: test-optional-settings test-preferences pack
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/scroller.js
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/animation.js
	python3 tests/monitor-transfer-shell.py

test-animation: pack
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/animation.js

test-optional-settings:
	GSETTINGS_BACKEND=memory gjs -m tests/optionalBarSettings.gjs.mjs

test-preferences:
	GTK_A11Y=none GSK_RENDERER=cairo GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0 \
		GSETTINGS_BACKEND=memory GDK_BACKEND=x11 xvfb-run -a gjs -m tests/preferences.gjs.mjs

test-monitor-transfer: pack
	python3 tests/monitor-transfer-shell.py

clean:
	rm -f $(ZIP)
