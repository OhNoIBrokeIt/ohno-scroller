UUID := ohno-scroller@ohnoibrokeit.dev
ZIP := $(UUID).shell-extension.zip
SCHEMA := schemas/dev.ohnoibrokeit.gnome-shell.extensions.ohno-scroller.gschema.xml

.PHONY: pack test clean

pack:
	gnome-extensions pack --force --schema=$(SCHEMA) .

test: pack
	dbus-run-session -- gnome-shell-test-tool --headless --extension $(ZIP) tests/automation/scroller.js

clean:
	rm -f $(ZIP)
