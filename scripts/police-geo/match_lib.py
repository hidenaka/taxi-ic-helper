def mesh_bounds(code, margin_deg=0.004):
    p, u, q, v = int(code[0:2]), int(code[2:4]), int(code[4]), int(code[5])
    lat0 = p / 1.5 + q / 12
    lon0 = u + 100 + v / 8
    return lat0 - margin_deg, lat0 + 1 / 12 + margin_deg, lon0 - margin_deg, lon0 + 1 / 8 + margin_deg


