// Minimal Gtk4 window for headless-shell testing: title/size from env.
imports.gi.versions.Gtk = '4.0';
const {Gtk, GLib} = imports.gi;

const title = GLib.getenv('TEST_TITLE') ?? 'test';
const app = new Gtk.Application({
    application_id: `dev.ohno.test.${title.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
});

app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title,
        default_width: 700,
        default_height: 500,
    });
    window.present();
});

app.run([]);
