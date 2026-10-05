"""导入原始商业 POI，并自动适配 EPSG:4326 数据库。"""
if __package__:
    from .import_points import main
else:
    from import_points import main

if __name__ == "__main__":
    main("commercial_pois")
