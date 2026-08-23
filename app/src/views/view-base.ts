import { AtlasElement } from '../components/base.js';
import { route, type Route } from '../router.js';
import { watch } from '../signal.js';
import { store } from '../store.js';

/** Views re-render on route + data changes and read their state from the query string. */
export class ViewElement extends AtlasElement {
  constructor() {
    super();
    watch(
      this,
      route,
      store.registry,
      store.index,
      store.coverage,
      store.stats,
      store.gaps,
      store.contributors,
    );
  }
  protected get route(): Route {
    return route.value;
  }
  protected get q(): URLSearchParams {
    return route.value.query;
  }
}
