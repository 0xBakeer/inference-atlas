# Keyboard reference

Press **`?`** in the app for a short version of this. **`esc`** goes back one step from
anywhere; **`q`** quits.

## Everywhere

| Key   | Does                                             |
| ----- | ------------------------------------------------ |
| `1`   | target view — what is worth running on your box  |
| `2`   | runs view — every measurement, filterable        |
| `3`   | pareto view — throughput against latency         |
| `4`   | coverage view — model × hardware heatmap         |
| `5`   | hardware picker                                  |
| `b`   | hardware picker (same view, mnemonic: _box_)     |
| `tab` | cycle those five views in order                  |
| `/`   | jump to the runs view and start filtering        |
| `r`   | refresh the data now                             |
| `?`   | help, and again to leave it                      |
| `esc` | back                                             |
| `q`   | quit (except while reading a recipe — see below) |

## Target and runs views

| Key       | Does                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| `j` / `↓` | next row                                                                                     |
| `k` / `↑` | previous row                                                                                 |
| `enter`   | open the selected run                                                                        |
| `g`       | open the selected run (the recipe needs the full record, so press `g` again once it is open) |

## Filtering (runs view)

`/` starts it. While filtering, every printable key types into the filter:

| Key              | Does                                   |
| ---------------- | -------------------------------------- |
| any character    | append to the filter                   |
| `backspace`      | delete the last character              |
| `enter` or `esc` | stop typing (the filter stays applied) |

The filter matches, case-insensitively, across the model, quantization, engine, engine
version, hardware, workload and kind of every row. Space-separated words must **all** match:
`qwen fp8` finds fp8 Qwen runs, `qwen bf16` finds none if no such run exists.

## Pareto view

| Key             | Does                  |
| --------------- | --------------------- |
| `j` / `↓` / `→` | next point            |
| `k` / `↑` / `←` | previous point        |
| `enter`         | open the selected run |

The selected point is drawn as `◉` and named in the panel underneath.

## Hardware picker (`b` or `5`)

| Key                        | Does                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `j` / `↓`                  | next device                                                                                 |
| `k` / `↑`                  | previous device                                                                             |
| `+` / `=` / `→`            | one more of this device                                                                     |
| `-` / `_` / `←`            | one fewer                                                                                   |
| `enter`                    | target the highlighted device, and save it to your config                                   |
| `enter` on **not listed?** | propose your box for the registry (asks first)                                              |
| `esc`                      | back — unless the app has not identified your machine yet, in which case it wants an answer |

The count is remembered per device while you browse, so you can set `4` on one row, look at
another, and come back to it still saying `4`.

## The "add your box" confirmation

| Key               | Does                                           |
| ----------------- | ---------------------------------------------- |
| `enter` / `y`     | open the pre-filled issue form in your browser |
| `c`               | copy the link instead of opening it            |
| `esc` / `n` / `q` | cancel — nothing is opened                     |

Nothing happens without one of those: the dialog holds the keyboard while it is up.

## Run detail

| Key   | Does                                     |
| ----- | ---------------------------------------- |
| `g`   | generate the install recipe for this run |
| `esc` | back to the list you came from           |

## Recipe view

| Key       | Does                                       |
| --------- | ------------------------------------------ |
| `j` / `↓` | scroll down                                |
| `k` / `↑` | scroll up                                  |
| `c`       | copy the whole recipe to the clipboard     |
| `1`–`9`   | send it to the _n_-th agent in your config |
| `esc`     | back to the run                            |

`q` does **not** quit from this view — it would be too easy to lose a recipe you were
reading. Press `esc` first.

## Notes

- Arrow keys work anywhere `j`/`k` do.
- Mouse is not used. Everything is reachable from the keyboard.
- The status bar at the bottom always lists the keys that apply to the view you are in.
