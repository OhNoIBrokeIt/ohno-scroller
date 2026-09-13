import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

function find(widget, predicate) {
    if (predicate(widget))
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const result = find(child, predicate);
        if (result)
            return result;
    }
    return null;
}

check(GLib.getenv('GSETTINGS_BACKEND') === 'memory', 'run with GSETTINGS_BACKEND=memory');
Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const {default: Preferences} = await import('../prefs.js');
Adw.init();
const repository = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const [, metadataBytes] = repository.get_child('metadata.json').load_contents(null);
const directory = GLib.dir_make_tmp('ohno-scroller-prefs-XXXXXX');
const schemasDirectory = `${directory}/schemas`;
const metadata = {...JSON.parse(new TextDecoder().decode(metadataBytes)),
    dir: Gio.File.new_for_path(directory), path: directory};
const originalDefault = Gio.SettingsSchemaSource.get_default;
const originalConnect = Gio.Settings.prototype.connect;
const connections = [];
let window;
try {
    GLib.mkdir_with_parents(schemasDirectory, 0o700);
    const [, scrollerSchema] = repository.get_child(
        'schemas/dev.ohnoibrokeit.gnome-shell.extensions.ohno-scroller.gschema.xml').load_contents(null);
    GLib.file_set_contents(`${schemasDirectory}/scroller.gschema.xml`, scrollerSchema);
    GLib.file_set_contents(`${schemasDirectory}/bar.gschema.xml`, `<schemalist>
      <schema id="org.gnome.shell.extensions.ohno-bar" path="/org/gnome/shell/extensions/ohno-bar/">
        <key name="performance-mode" type="b"><default>false</default></key>
      </schema></schemalist>`);
    const [, , , status] = GLib.spawn_sync(null, ['glib-compile-schemas', schemasDirectory], null,
        GLib.SpawnFlags.SEARCH_PATH, null);
    check(status === 0, 'could not compile optional Bar fixture');
    const source = Gio.SettingsSchemaSource.new_from_directory(schemasDirectory, originalDefault(), false);
    Gio.SettingsSchemaSource.get_default = () => source;
    Gio.Settings.prototype.connect = function (signal, callback) {
        const id = originalConnect.call(this, signal, callback);
        if (signal === 'changed::performance-mode')
            connections.push({settings: this, id});
        return id;
    };
    window = new Adw.PreferencesWindow();
    const preferences = new Preferences(metadata);
    preferences.fillPreferencesWindow(window);
    Gio.Settings.prototype.connect = originalConnect;
    const shortcut = find(window, widget => widget instanceof Adw.ActionRow && widget.title === 'Toggle tiling');
    const shortcutText = preferences.getSettings().get_strv('toggle-tiling').join(', ');
    check(shortcut && find(shortcut, widget => widget instanceof Gtk.Label && widget.get_text() === shortcutText),
        'shortcut accelerators should render as literal text');
    check(connections.length === 1, 'preferences should own exactly one optional pause listener');
    const {settings, id} = connections[0];
    const group = find(window, widget => widget instanceof Adw.PreferencesGroup &&
        widget.title === 'Movement animations paused');
    check(group && !group.visible, 'normal mode should hide the inherited-pause explanation');
    settings.set_boolean('performance-mode', true);
    check(group.visible, 'manual pause should reveal the explanation immediately');
    const button = find(group, widget => widget instanceof Gtk.Button && widget.label === 'Turn off');
    check(button, 'pause explanation must offer recovery');
    button.emit('clicked');
    check(!settings.get_boolean('performance-mode') && !group.visible,
        'recovery should clear the existing switch and hide the explanation');
    window.present();
    const loop = new GLib.MainLoop(null, false);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        window.close();
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    check(!GObject.signal_handler_is_connected(settings, id), 'closed preferences retained the pause listener');
    print('PASS Scroller preferences: live inherited pause, recovery and close cleanup');
} finally {
    Gio.Settings.prototype.connect = originalConnect;
    Gio.SettingsSchemaSource.get_default = originalDefault;
    window?.destroy();
    for (const name of ['bar.gschema.xml', 'scroller.gschema.xml', 'gschemas.compiled']) {
        const file = Gio.File.new_for_path(`${schemasDirectory}/${name}`);
        if (file.query_exists(null))
            file.delete(null);
    }
    Gio.File.new_for_path(schemasDirectory).delete(null);
    Gio.File.new_for_path(directory).delete(null);
}
