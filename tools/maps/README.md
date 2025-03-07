# BrowserQuest map exporter

**Disclaimer:** The exporting process may not be the most painless, quick, or
efficient.

## Editing the map

-   Install the [Tiled](https://www.mapeditor.org/) editor.
-   Open the `tmx/map.tmx` file in Tiled and start editing.

**Note:** There currently is no documentation on how to edit
BrowserQuest-specific objects/layers in Tiled. Please refer to `tmx/map.tmx`
as an example if you want to create your own map.

## Using the exporter

This tool is to be used from the command line after the TMX file has been
saved from the Tiled editor.

-   From the package root, run `npm run export-maps`.

Alternatively, the `export.js` script from this directory can be invoked
directly as `node export.js <MODE>`, where `<MODE>` is one of `client`,
`server`, or `both`.

**Warning:** Depending on the `.tmx` file size, the exporting process can take
up to several minutes.

## Things to know

The client map file contains data about terrain tile layers, collision cells,
doors, music areas, etc. The server map file contains data about static entity
spawning points, spawning areas, collision cells, etc.

Depending on what you want to change, it's therefore not always needed to
export both maps. Also, each `world_server.json` file change requires a server
restart.

**Known bugs:**

-   There currently needs to be an empty layer at the bottom of the Tiled
    layer stack or else the first terrain layer will be missing. (I.e., if you
    remove the "don't remove this layer" layer from the `map.tmx` file, the
    'sand' tiles will be missing on the beach.)

## Contributing / Ideas for improvement

Here are a few ideas for anyone who might want to help make this tool better:

-   Remove hard-coded filenames from export.js (e.g. `map.tmx`, perhaps also
    `world_client.json`) in order to allow easier switching to different map
    files.
-   Fix known bugs (see the section above).
-   Write documentation about map editing in the Tiled editor (i.e. editing
    BrowserQuest-specific properties of doors, chests, spawning areas, etc.)
-   Write documentation about the BrowserQuest map JSON format, both for
    client and server map types.
-   Get rid of the `tmx2json.js` step which can currently take up to several
    minutes. Note: There is a JSON exporter built in Tiled since version 0.8.0
    which could be useful. It is not used because our tool was written before
    the 0.8.0 release.
-   A complete rewrite of this tool using a custom Tiled plugin would surely
    be a better approach than the current one. Being able to export directly
    from Tiled would be much easier to use. Also, the export process is
    currently too slow.
-   A complete rewrite of this tool using a custom Tiled plugin would surely
    be a better approach than the current one. Being able to export directly
    from Tiled would be much easier to use. Also, the export process is
    currently too slow.

**Additional resources:**

-   Tiled editor wiki: <https://github.com/mapeditor/tiled/wiki>
-   TMX map format documentation:
    <https://doc.mapeditor.org/en/stable/reference/tmx-map-format/>
