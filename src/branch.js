export const BRANCH = {
  id: 24,
  iikoId: '9f5b02ea-b7c5-450c-8b1e-d66ccd72f9dd',
  name: { en: 'Bellissimo Amir Temur', ru: 'Bellissimo Amir Temur', uz: 'Bellissimo Amir Temur' },
  openTime: '11:00:00',
  closeTime: '23:00:00',
  latitude: 41.332218,
  longitude: 69.284734,
  deliveryDuration: 35,
  deltaMinutesBetweenDeliveries: 10,
  maxLimitForCouriers: 3,
  goOutFromBranchMin: 2,
  giveOrderToClientMin: 2,
  zone: [
    [69.309844,41.356036],[69.302866,41.354529],[69.301876,41.354298],
    [69.300844,41.354058],[69.299617,41.353762],[69.298682,41.353567],
    [69.297694,41.353345],[69.296455,41.353057],[69.295022,41.352717],
    [69.293822,41.351906],[69.29271,41.35116],[69.291083,41.350945],
    [69.290293,41.351042],[69.289114,41.351214],[69.287629,41.351246],
    [69.287345,41.349119],[69.284799,41.34913],[69.280825,41.3497],
    [69.278335,41.350121],[69.276952,41.35057],[69.275526,41.351503],
    [69.27321,41.353126],[69.270957,41.354528],[69.269601,41.355344],
    [69.259473,41.346158],[69.257586,41.343456],[69.257654,41.340538],
    [69.257244,41.338134],[69.26191689814753,41.33553910218266],
    [69.2644391765057,41.3347062548345],[69.26771846728613,41.332916584793146],
    [69.26830987738194,41.33258351152659],[69.27040068011131,41.33120874592903],
    [69.27337366799368,41.32905556051346],[69.27446177373723,41.32862087106347],
    [69.27270948346707,41.32238782393042],[69.282012,41.321563],
    [69.286587,41.320987],[69.28885,41.320592],[69.290379,41.319952],
    [69.291714,41.319021],[69.293365,41.31712],[69.29388,41.317416],
    [69.298346,41.319316],[69.300622,41.32033],[69.302769,41.32099],
    [69.30321,41.320972],[69.304163,41.325006],[69.304786,41.327355],
    [69.305351,41.329422],[69.305601,41.330632],[69.304807,41.330949],
    [69.302892,41.333602],[69.309763,41.334737],[69.311231,41.334865],
    [69.309837,41.339456],[69.308025,41.341778],[69.306346,41.343665],
    [69.309057,41.344622],[69.311652,41.345861],[69.313283,41.346678],
    [69.315241,41.347645],[69.317178,41.348453],[69.320638,41.349609],
    [69.31479,41.353105],[69.309844,41.356036]
  ]
};

export const MAP_BOUNDS = {
  minLongitude: 69.252,
  maxLongitude: 69.324,
  minLatitude: 41.314,
  maxLatitude: 41.359
};

export function projectCoordinate(longitude, latitude) {
  const x = 40 + (longitude - MAP_BOUNDS.minLongitude) / (MAP_BOUNDS.maxLongitude - MAP_BOUNDS.minLongitude) * 720;
  const y = 35 + (MAP_BOUNDS.maxLatitude - latitude) / (MAP_BOUNDS.maxLatitude - MAP_BOUNDS.minLatitude) * 530;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

export function unprojectCoordinate(x, y) {
  return {
    longitude: MAP_BOUNDS.minLongitude + (x - 40) / 720 * (MAP_BOUNDS.maxLongitude - MAP_BOUNDS.minLongitude),
    latitude: MAP_BOUNDS.maxLatitude - (y - 35) / 530 * (MAP_BOUNDS.maxLatitude - MAP_BOUNDS.minLatitude)
  };
}

export const BRANCH_POINT = projectCoordinate(BRANCH.longitude, BRANCH.latitude);
export const BRANCH_ZONE_POINTS = BRANCH.zone.map(([longitude, latitude]) => projectCoordinate(longitude, latitude));
