UUID := ohno-scroller@ohnoibrokeit.dev
ZIP := $(UUID).shell-extension.zip
SCHEMA := schemas/dev.ohnoibrokeit.gnome-shell.extensions.ohno-scroller.gschema.xml

.PHONY: pack test test-animation clean

pack:
	gnome-extensions pack --force --schema=$(SCHEMA) .

test: pack
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/scroller.js
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/animation.js

test-animation: pack
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/animation.js

clean:
	rm -f $(ZIP)
