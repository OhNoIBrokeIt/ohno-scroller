import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UUID = 'ohno-bar@ohnoibrokeit.dev';
const SCHEMA_ID = 'org.gnome.shell.extensions.ohno-bar';

function settingsFromSchema(schema) {
    if (!schema?.has_key('performance-mode') ||
        schema.get_key('performance-mode').get_value_type().dup_string() !== 'b')
        return null;
    return new Gio.Settings({settings_schema: schema});
}

// Both Shell and preferences can discover the optional controller without
// importing one another or watching installation directories. Call once per
// lifetime; the consumer owns its settings change signal and disconnects it.
export function optionalBarSettings({
    extensionPath = null,
    userDataDir = GLib.get_user_data_dir(),
    systemDataDirs = GLib.get_system_data_dirs(),
    defaultSource = Gio.SettingsSchemaSource.get_default(),
} = {}) {
    const directories = [];
    if (typeof extensionPath === 'string' && extensionPath)
        directories.push(GLib.build_filenamev([extensionPath, 'schemas']));
    for (const root of [userDataDir, ...systemDataDirs]) {
        if (root)
            directories.push(GLib.build_filenamev([
                root, 'gnome-shell', 'extensions', UUID, 'schemas',
            ]));
    }

    for (const directory of new Set(directories)) {
        if (!GLib.file_test(`${directory}/gschemas.compiled`, GLib.FileTest.IS_REGULAR))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                directory, defaultSource, false);
            const schema = source.lookup(SCHEMA_ID, false);
            const settings = settingsFromSchema(schema);
            if (settings)
                return settings;
        } catch {
            // Missing/corrupt optional installations must not prevent tiling
            // or preferences from opening. Try the remaining normal locations.
        }
    }

    return settingsFromSchema(defaultSource?.lookup(SCHEMA_ID, true));
}
