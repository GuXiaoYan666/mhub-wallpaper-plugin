using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace MHubStartupPlugin
{
    internal static class UiPalette
    {
        internal static readonly Color Ink = Color.FromArgb(26, 29, 33);
        internal static readonly Color InkSoft = Color.FromArgb(70, 76, 84);
        internal static readonly Color InkFaint = Color.FromArgb(138, 145, 154);
        internal static readonly Color Line = Color.FromArgb(224, 228, 234);
        internal static readonly Color Card = Color.FromArgb(255, 255, 255);
        internal static readonly Color Dark = Color.FromArgb(23, 25, 28);
        internal static readonly Color DarkHover = Color.FromArgb(44, 48, 53);
        internal static readonly Color Mint = Color.FromArgb(64, 190, 140);
        internal static readonly Color Rose = Color.FromArgb(226, 96, 110);
        internal static readonly Color Sky = Color.FromArgb(88, 132, 220);
    }

    internal static class Draw
    {
        internal static GraphicsPath Round(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = Math.Max(0, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
            if (d <= 0)
            {
                path.AddRectangle(bounds);
                return path;
            }
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        internal static Region RoundRegion(Rectangle bounds, int radius)
        {
            using (GraphicsPath path = Round(bounds, radius)) return new Region(path);
        }

        internal static void Shadow(Graphics g, Rectangle bounds, int radius, int alpha)
        {
            for (int i = 6; i >= 1; i--)
            {
                Rectangle r = new Rectangle(bounds.X - i, bounds.Y - i + 2, bounds.Width + i * 2, bounds.Height + i * 2);
                using (GraphicsPath path = Round(r, radius + i))
                using (Pen pen = new Pen(Color.FromArgb(alpha / (i + 2), 70, 84, 104), 1.4f))
                    g.DrawPath(pen, path);
            }
        }

        internal static void Glyph(Graphics g, string glyph, RectangleF box, Color color, float weight)
        {
            if (string.IsNullOrEmpty(glyph)) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float u = Math.Min(box.Width, box.Height);
            float cx = box.X + box.Width / 2f;
            float cy = box.Y + box.Height / 2f;
            using (Pen pen = new Pen(color, weight))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                if (glyph == "close")
                {
                    g.DrawLine(pen, cx - u * 0.14f, cy - u * 0.14f, cx + u * 0.14f, cy + u * 0.14f);
                    g.DrawLine(pen, cx + u * 0.14f, cy - u * 0.14f, cx - u * 0.14f, cy + u * 0.14f);
                }
                else if (glyph == "check")
                {
                    g.DrawLines(pen, new PointF[]
                    {
                        new PointF(cx - u * 0.13f, cy + u * 0.01f),
                        new PointF(cx - u * 0.03f, cy + u * 0.11f),
                        new PointF(cx + u * 0.15f, cy - u * 0.10f)
                    });
                }
                else if (glyph == "back")
                {
                    g.DrawLine(pen, cx + u * 0.10f, cy - u * 0.16f, cx - u * 0.08f, cy);
                    g.DrawLine(pen, cx - u * 0.08f, cy, cx + u * 0.10f, cy + u * 0.16f);
                }
            }
        }
    }

    internal sealed class LightSurface : Panel
    {
        internal int Radius = 26;
        internal Color TopTint = Color.FromArgb(255, 255, 255);
        internal Color BottomTint = Color.FromArgb(247, 249, 252);
        internal Color Edge = Color.FromArgb(220, 226, 234);
        internal bool ShowShadow = true;

        internal LightSurface()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Margin = Padding.Empty;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            base.OnPaintBackground(e);
            if (Width < 4 || Height < 4) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            if (ShowShadow) Draw.Shadow(g, new Rectangle(2, 3, Width - 5, Height - 6), Radius, 40);
            using (GraphicsPath path = Draw.Round(bounds, Radius))
            {
                using (LinearGradientBrush fill = new LinearGradientBrush(bounds, TopTint, BottomTint, 90f))
                    g.FillPath(fill, path);
                using (Pen edge = new Pen(Edge, 1f)) g.DrawPath(edge, path);
            }
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width > 2 && Height > 2)
                Region = Draw.RoundRegion(new Rectangle(Point.Empty, Size), Radius);
        }
    }

    internal sealed class PillButton : Button
    {
        internal bool DarkStyle = true;
        internal bool BorderOnly;
        internal string Glyph;
        private bool _hover;
        private bool _pressed;

        internal PillButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            UseVisualStyleBackColor = false;
            Cursor = Cursors.Hand;
            Margin = Padding.Empty;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; _pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { _pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            int radius = Height / 2;
            Color ink;
            if (!Enabled)
            {
                using (GraphicsPath path = Draw.Round(bounds, radius))
                using (SolidBrush fill = new SolidBrush(Color.FromArgb(236, 239, 243)))
                    g.FillPath(fill, path);
                ink = Color.FromArgb(166, 172, 180);
            }
            else if (DarkStyle)
            {
                Color bg = _pressed ? Color.FromArgb(52, 56, 61) : (_hover ? UiPalette.DarkHover : UiPalette.Dark);
                using (GraphicsPath path = Draw.Round(bounds, radius))
                using (SolidBrush fill = new SolidBrush(bg))
                    g.FillPath(fill, path);
                ink = Color.White;
            }
            else
            {
                using (GraphicsPath path = Draw.Round(bounds, radius))
                {
                    using (SolidBrush fill = new SolidBrush(_hover ? Color.FromArgb(250, 251, 253) : Color.White))
                        g.FillPath(fill, path);
                    using (Pen edge = new Pen(_hover ? Color.FromArgb(198, 204, 213) : UiPalette.Line, 1f))
                        g.DrawPath(edge, path);
                }
                ink = BorderOnly ? UiPalette.InkSoft : UiPalette.Ink;
            }

            int textLeft = 0;
            if (!string.IsNullOrEmpty(Glyph))
            {
                RectangleF box = new RectangleF(10, 0, Height, Height);
                Draw.Glyph(g, Glyph, box, ink, 1.6f);
                textLeft = Height - 2;
            }
            Rectangle textRect = new Rectangle(textLeft, 0, Math.Max(0, Width - textLeft), Height);
            TextRenderer.DrawText(g, Text, Font, textRect, ink,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width > 2 && Height > 2)
                Region = Draw.RoundRegion(new Rectangle(Point.Empty, Size), Height / 2);
        }
    }

    internal sealed class IconCircle : Button
    {
        internal string Glyph = "close";
        private bool _hover;

        internal IconCircle()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            UseVisualStyleBackColor = false;
            Cursor = Cursors.Hand;
            Margin = Padding.Empty;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = Draw.Round(bounds, Width / 2))
            {
                using (SolidBrush fill = new SolidBrush(_hover ? Color.White : Color.FromArgb(244, 246, 249)))
                    g.FillPath(fill, path);
                using (Pen edge = new Pen(_hover ? Color.FromArgb(200, 206, 215) : UiPalette.Line, 1f))
                    g.DrawPath(edge, path);
            }
            Draw.Glyph(g, Glyph, new RectangleF(0, 0, Width, Height), UiPalette.InkSoft, 1.6f);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width > 2 && Height > 2)
                Region = Draw.RoundRegion(new Rectangle(Point.Empty, Size), Width / 2);
        }
    }

    internal sealed class ChipToggle : Control
    {
        internal string Title;
        private bool _checked = true;
        private bool _hover;

        internal ChipToggle()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            Margin = Padding.Empty;
        }

        internal bool Checked
        {
            get { return _checked; }
            set { _checked = value; Invalidate(); }
        }

        protected override void OnClick(EventArgs e)
        {
            base.OnClick(e);
            _checked = !_checked;
            Invalidate();
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = Draw.Round(bounds, Height / 2))
            {
                Color fill = _checked ? Color.White : Color.FromArgb(_hover ? 40 : 18, 255, 255, 255);
                using (SolidBrush brush = new SolidBrush(fill)) g.FillPath(brush, path);
                using (Pen edge = new Pen(_checked ? Color.FromArgb(206, 212, 221) : Color.FromArgb(216, 222, 230), 1f))
                    g.DrawPath(edge, path);
            }

            int dot = Math.Max(14, Height - 16);
            Rectangle dotRect = new Rectangle(10, (Height - dot) / 2, dot, dot);
            using (GraphicsPath path = Draw.Round(dotRect, dot / 2))
            {
                using (SolidBrush brush = new SolidBrush(_checked ? UiPalette.Dark : Color.FromArgb(226, 231, 237)))
                    g.FillPath(brush, path);
            }
            Draw.Glyph(g, "check", new RectangleF(dotRect.X, dotRect.Y, dotRect.Width, dotRect.Height),
                _checked ? Color.White : Color.FromArgb(180, 188, 198), 1.4f);

            Rectangle textRect = new Rectangle(dotRect.Right + 6, 0, Width - dotRect.Right - 10, Height);
            TextRenderer.DrawText(g, Title, Font, textRect,
                _checked ? UiPalette.InkSoft : Color.FromArgb(158, 166, 176),
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width > 2 && Height > 2)
                Region = Draw.RoundRegion(new Rectangle(Point.Empty, Size), Height / 2);
        }
    }

    internal sealed class SpecDot : Control
    {
        internal Color Tint = UiPalette.Sky;

        internal SpecDot()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        internal void SetTint(Color color) { Tint = color; Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int d = Math.Max(6, Math.Min(Width, Height) - 6);
            using (SolidBrush core = new SolidBrush(Tint))
                g.FillEllipse(core, (Width - d) / 2f, (Height - d) / 2f, d, d);
        }
    }

    internal sealed class BrandTile : Control
    {
        internal BrandTile()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = Draw.Round(bounds, 22))
            {
                using (LinearGradientBrush fill = new LinearGradientBrush(bounds,
                    Color.FromArgb(38, 41, 46), Color.FromArgb(14, 15, 17), 90f))
                    g.FillPath(fill, path);
            }
            using (Font font = new Font("Arial", Height * 0.56f, FontStyle.Bold, GraphicsUnit.Pixel))
                TextRenderer.DrawText(g, "M", font, bounds, Color.White,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            if (Width > 2 && Height > 2)
                Region = Draw.RoundRegion(new Rectangle(Point.Empty, Size), 22);
        }
    }

    internal sealed class MainForm : Form
    {
        private Panel _mainPage;
        private Panel _logPage;
        private Label _pathLabel;
        private Label _freeLabel;
        private Label _statusLabel;
        private Label _versionLabel;
        private Label _titleLabel;
        private BrandTile _brand;
        private PillButton _installButton;
        private PillButton _browseButton;
        private PillButton _restoreLink;
        private PillButton _logLink;
        private PillButton _logBack;
        private IconCircle _closeButton;
        private ChipToggle _petChip;
        private ChipToggle _lyricChip;
        private ChipToggle _sysdeckChip;
        private SpecDot _statusDot;
        private TextBox _logBox;
        private string _pathValue = string.Empty;
        private bool _busy;

        internal MainForm()
        {
            Text = "M HUB 增强安装器 · 4.1";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ShowIcon = false;
            DoubleBuffered = true;
            KeyPreview = true;
            BackColor = Color.FromArgb(238, 241, 245);
            Font = new Font("Microsoft YaHei UI", 9f);
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(960, 676);

            BuildUi();
            WireEvents();
            SetStatus("准备就绪 · 官方文件将自动备份", UiPalette.Sky);
            Log("M HUB 增强安装器 4.1 已就绪。");
        }

        private Font F(float points, FontStyle style)
        {
            return new Font("Microsoft YaHei UI", Math.Max(5.5f, points), style, GraphicsUnit.Point);
        }

        private Label MkLabel(string text, float size, Color color, FontStyle style)
        {
            Label label = new Label();
            label.Text = text;
            label.AutoSize = false;
            label.BackColor = Color.Transparent;
            label.ForeColor = color;
            label.Font = F(size, style);
            label.Margin = Padding.Empty;
            label.TextAlign = ContentAlignment.MiddleCenter;
            return label;
        }

        private void BuildUi()
        {
            _closeButton = new IconCircle();
            _closeButton.Glyph = "close";
            _closeButton.SetBounds(872, 24, 40, 40);
            _closeButton.Click += delegate { Close(); };

            _brand = new BrandTile();
            _brand.SetBounds(432, 74, 96, 96);

            _titleLabel = MkLabel("M HUB", 24f, UiPalette.Ink, FontStyle.Bold);
            _titleLabel.SetBounds(280, 184, 400, 46);

            _versionLabel = MkLabel("版本 4.1", 10f, UiPalette.InkFaint, FontStyle.Regular);
            _versionLabel.SetBounds(280, 228, 400, 22);

            LightSurface pathCard = new LightSurface();
            pathCard.Radius = 28;
            pathCard.Edge = Color.FromArgb(219, 225, 233);
            pathCard.SetBounds(150, 276, 660, 58);

            _pathLabel = MkLabel("安装在 --", 9.5f, UiPalette.InkSoft, FontStyle.Regular);
            _pathLabel.TextAlign = ContentAlignment.MiddleLeft;
            _pathLabel.SetBounds(26, 0, 510, 58);

            _browseButton = new PillButton();
            _browseButton.DarkStyle = true;
            _browseButton.Text = "更改";
            _browseButton.Font = F(9f, FontStyle.Regular);
            _browseButton.SetBounds(660 - 16 - 78, 11, 78, 36);
            _browseButton.Click += delegate { BrowseForFolder(); };

            pathCard.Controls.AddRange(new Control[] { _pathLabel, _browseButton });

            _freeLabel = MkLabel("所需空间 4.1 MB    可用空间 --", 8.5f, UiPalette.InkFaint, FontStyle.Regular);
            _freeLabel.SetBounds(240, 342, 480, 20);

            _petChip = MakeChip("桌宠", 303, 100);
            _lyricChip = MakeChip("歌词桥", 415, 110);
            _sysdeckChip = MakeChip("桌面面板", 537, 120);

            _installButton = new PillButton();
            _installButton.DarkStyle = true;
            _installButton.Text = "立即安装";
            _installButton.Font = F(12f, FontStyle.Bold);
            _installButton.SetBounds(240, 420, 480, 60);
            _installButton.Click += InstallButtonClick;

            _restoreLink = new PillButton();
            _restoreLink.DarkStyle = false;
            _restoreLink.BorderOnly = true;
            /* 明确的卸载入口：卸载插件并还原官方文件（保留用户配置与数据）。 */
            _restoreLink.Text = "卸载插件（还原官方文件）";
            _restoreLink.Font = F(9f, FontStyle.Regular);
            _restoreLink.SetBounds(360, 496, 240, 34);
            _restoreLink.Click += UninstallButtonClick;

            _statusDot = new SpecDot();
            _statusDot.SetBounds(38, 638, 12, 12);

            _statusLabel = MkLabel("准备就绪", 8.5f, UiPalette.InkFaint, FontStyle.Regular);
            _statusLabel.TextAlign = ContentAlignment.MiddleLeft;
            _statusLabel.SetBounds(58, 626, 520, 36);

            _logLink = new PillButton();
            _logLink.DarkStyle = false;
            _logLink.BorderOnly = true;
            _logLink.Text = "运行日志";
            _logLink.Font = F(8.5f, FontStyle.Regular);
            _logLink.SetBounds(810, 626, 108, 32);
            _logLink.Click += delegate { ToggleLog(); };

            _mainPage = new Panel();
            _mainPage.SetBounds(0, 0, 960, 676);
            _mainPage.BackColor = Color.Transparent;
            _mainPage.Controls.AddRange(new Control[]
            {
                _brand, _titleLabel, _versionLabel, pathCard, _freeLabel,
                _petChip, _lyricChip, _sysdeckChip, _installButton, _restoreLink,
                _statusDot, _statusLabel, _logLink
            });

            BuildLogPage();

            Controls.Add(_mainPage);
            Controls.Add(_logPage);
            Controls.Add(_closeButton);

            GiveDrag(this);
            GiveDrag(_mainPage);
            GiveDrag(_titleLabel);
            GiveDrag(_versionLabel);
            GiveDrag(_statusLabel);
            GiveDrag(_freeLabel);
            GiveDrag(pathCard);
        }

        private ChipToggle MakeChip(string title, int x, int width)
        {
            ChipToggle chip = new ChipToggle();
            chip.Title = title;
            chip.Font = F(9f, FontStyle.Regular);
            chip.SetBounds(x, 374, width, 32);
            return chip;
        }

        private void BuildLogPage()
        {
            _logPage = new Panel();
            _logPage.SetBounds(0, 0, 960, 676);
            _logPage.BackColor = Color.Transparent;
            _logPage.Visible = false;

            LightSurface card = new LightSurface();
            card.Radius = 22;
            card.SetBounds(140, 96, 680, 470);

            Label title = MkLabel("运行日志", 14f, UiPalette.Ink, FontStyle.Bold);
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.SetBounds(28, 20, 260, 32);

            _logBack = new PillButton();
            _logBack.DarkStyle = false;
            _logBack.BorderOnly = true;
            _logBack.Glyph = "back";
            _logBack.Text = "返回";
            _logBack.Font = F(9f, FontStyle.Regular);
            _logBack.SetBounds(680 - 28 - 96, 20, 96, 34);
            _logBack.Click += delegate { ToggleLog(); };

            _logBox = new TextBox();
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.BorderStyle = BorderStyle.None;
            _logBox.BackColor = Color.FromArgb(248, 250, 252);
            _logBox.ForeColor = Color.FromArgb(60, 66, 74);
            _logBox.Font = new Font("Consolas", 9f, FontStyle.Regular, GraphicsUnit.Point);
            _logBox.SetBounds(28, 66, 624, 376);

            card.Controls.AddRange(new Control[] { title, _logBack, _logBox });
            _logPage.Controls.Add(card);
            GiveDrag(card);
            GiveDrag(title);
        }

        private void GiveDrag(Control control)
        {
            control.MouseDown += DragWindow;
        }

        private void WireEvents()
        {
            Shown += delegate
            {
                EnableWindowEffects();
                string detected = Detection.Detect();
                if (detected != null)
                {
                    UpdateDirectory(detected);
                    Log("已检测到安装目录：" + detected);
                }
                else
                {
                    _pathLabel.Text = "请选择 M HUB 安装目录";
                    _pathLabel.ForeColor = UiPalette.InkFaint;
                    SetStatus("未检测到安装目录，请点击「更改」手动选择", UiPalette.InkFaint);
                    Log("未自动检测到 M HUB 安装目录，请手动选择。");
                }
            };
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!_busy) return;
                e.Cancel = true;
                SetStatus("操作进行中，请等待完成后再关闭", UiPalette.Rose);
            };
            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape && _logPage.Visible)
                {
                    ToggleLog();
                    e.Handled = true;
                }
            };
        }

        private void InstallButtonClick(object sender, EventArgs e)
        {
            if (_busy) return;
            string dir = ValidateDirectory();
            if (dir == null) return;
            if (!Program.HasHubExe(dir))
            {
                DialogResult confirm = MessageBox.Show(this,
                    "该目录中没有找到 MCHOSE HUB.exe 或 M HUB.exe，仍要继续安装吗？",
                    "确认安装目录", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (confirm != DialogResult.Yes) return;
            }
            InstallOptions options = new InstallOptions();
            options.PetHub = _petChip.Checked;
            options.LyricBridge = _lyricChip.Checked;
            options.Sysdeck = _sysdeckChip.Checked;
            RunOperation(true, dir, options);
        }

        private void UninstallButtonClick(object sender, EventArgs e)
        {
            if (_busy) return;
            string dir = ValidateDirectory();
            if (dir == null) return;
            DialogResult confirm = MessageBox.Show(this,
                "将恢复官方入口与归档，并移除本安装器拥有且未被修改的文件。\r\n" +
                "壁纸参数、桌宠配置、成长数据、日志、高清缓存和用户导入图集均会保留。\r\n\r\n是否继续？",
                "卸载插件", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (confirm != DialogResult.Yes) return;
            RunOperation(false, dir, null);
        }

        private string ValidateDirectory()
        {
            string dir = Program.NormalizePath(_pathValue);
            if (Check.IsValid(dir)) return dir;
            MessageBox.Show(this, "当前目录不是有效的 M HUB 安装目录，请点击「更改」重新选择。",
                "目录无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return null;
        }

        private void RunOperation(bool installing, string dir, InstallOptions options)
        {
            SetBusy(true);
            SetStatus(installing ? "正在安装增强组件…" : "正在还原官方文件…", UiPalette.Sky);
            Log(installing ? "开始安装 / 更新：" + dir : "开始卸载 / 还原：" + dir);
            Installer.Progress = delegate(string text)
            {
                try
                {
                    if (IsDisposed || !IsHandleCreated) return;
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (IsDisposed) return;
                        Log(text);
                        _statusLabel.Text = text;
                    });
                }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
            };

            Thread worker = new Thread(delegate()
            {
                InstallResult installResult = null;
                UninstallResult uninstallResult = null;
                Exception error = null;
                try
                {
                    if (installing) installResult = Installer.Install(dir, false, options);
                    else uninstallResult = Installer.Uninstall(dir);
                }
                catch (Exception ex) { error = ex; }
                finally
                {
                    Installer.Progress = null;
                    try
                    {
                        if (!IsDisposed && IsHandleCreated)
                            BeginInvoke((MethodInvoker)delegate
                            {
                                FinishOperation(installing, dir, installResult, uninstallResult, error);
                            });
                    }
                    catch (ObjectDisposedException) { }
                    catch (InvalidOperationException) { }
                }
            });
            worker.IsBackground = true;
            worker.Name = installing ? "M HUB installer" : "M HUB uninstaller";
            worker.Start();
        }

        private void FinishOperation(bool installing, string dir, InstallResult installResult,
            UninstallResult uninstallResult, Exception error)
        {
            if (IsDisposed) return;
            SetBusy(false);
            if (error != null)
            {
                string action = installing ? "安装" : "还原";
                SetStatus(action + "未完成：" + error.Message, UiPalette.Rose);
                Log(action + "失败：" + error.Message);
                MessageBox.Show(this, action + "失败：\r\n\r\n" + error.Message,
                    action + "未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (installing)
            {
                SetStatus("安装完成，已写入 " + installResult.FileCount + " 个文件", UiPalette.Mint);
                Log("安装完成，写入 " + installResult.FileCount + " 个文件。");
                if (!string.IsNullOrEmpty(Installer.LastNotice)) Log(Installer.LastNotice);
                Log("备份目录：" + installResult.BackupDir);
            }
            else
            {
                SetStatus("已还原 " + uninstallResult.Restored + " 个文件，移除 " +
                    uninstallResult.Removed + " 个新增文件", UiPalette.Mint);
                Log("已还原 " + uninstallResult.Restored + " 个文件，移除 " + uninstallResult.Removed + " 个新增文件。");
                if (uninstallResult.BackupDir != null) Log("使用的备份：" + uninstallResult.BackupDir);
            }

            if (installing && Program.HasHubExe(dir))
            {
                DialogResult answer = MessageBox.Show(this,
                    "增强组件已安装。是否立即重启 M HUB 以查看效果？",
                    "安装完成", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer == DialogResult.Yes)
                {
                    try
                    {
                        Log("正在重启 M HUB…");
                        Installer.RestartHub(dir);
                        SetStatus("M HUB 已启动", UiPalette.Mint);
                        Log("已启动 M HUB。");
                    }
                    catch (Exception ex)
                    {
                        Log("重启失败：" + ex.Message);
                        MessageBox.Show(this, "组件已安装，但 M HUB 未能自动重启：\r\n" + ex.Message,
                            "请手动重启", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
            }
            else if (!installing)
            {
                MessageBox.Show(this, "官方文件已恢复，用户数据保持原样。\r\n重启 M HUB 后生效。",
                    "还原完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _installButton.Enabled = !busy;
            _restoreLink.Enabled = !busy;
            _browseButton.Enabled = !busy;
            _petChip.Enabled = !busy;
            _lyricChip.Enabled = !busy;
            _sysdeckChip.Enabled = !busy;
            _closeButton.Enabled = !busy;
            Cursor = busy ? Cursors.AppStarting : Cursors.Default;
        }

        private void SetStatus(string text, Color tint)
        {
            _statusLabel.Text = text;
            _statusDot.SetTint(tint);
        }

        private void BrowseForFolder()
        {
            if (_busy) return;
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "请选择 M HUB 安装目录（包含 M HUB.exe 或 MCHOSE HUB.exe）";
                dialog.ShowNewFolderButton = false;
                if (Check.IsValid(_pathValue)) dialog.SelectedPath = _pathValue;
                else if (Directory.Exists(@"C:\Program Files\M HUB")) dialog.SelectedPath = @"C:\Program Files\M HUB";
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string picked = Program.NormalizePath(dialog.SelectedPath);
                if (!Check.IsValid(picked))
                {
                    MessageBox.Show(this,
                        "所选目录不是有效的 M HUB 安装目录。\r\n\r\n目录中应包含 M HUB.exe / MCHOSE HUB.exe，或官方 renderer 资源目录。",
                        "目录无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                UpdateDirectory(picked);
                Log("已选择安装目录：" + picked);
            }
        }

        private void UpdateDirectory(string dir)
        {
            _pathValue = dir;
            _pathLabel.Text = "安装在 " + dir;
            _pathLabel.ForeColor = UiPalette.InkSoft;
            _freeLabel.Text = "所需空间 4.1 MB    可用空间 " + FreeSpaceText(dir);
            Log("安装目录已验证：" + dir);
        }

        private string FreeSpaceText(string dir)
        {
            try
            {
                string root = Path.GetPathRoot(dir);
                if (string.IsNullOrEmpty(root)) return "--";
                DriveInfo drive = new DriveInfo(root);
                double gb = drive.AvailableFreeSpace / 1024d / 1024d / 1024d;
                return gb >= 10 ? gb.ToString("0") + " GB" : gb.ToString("0.0") + " GB";
            }
            catch { return "--"; }
        }

        private void ToggleLog()
        {
            bool open = !_logPage.Visible;
            _logPage.Visible = open;
            _mainPage.Visible = !open;
            if (open)
            {
                _logPage.BringToFront();
                _logBox.SelectionStart = _logBox.TextLength;
                _logBox.ScrollToCaret();
            }
            else
            {
                _mainPage.BringToFront();
            }
            _closeButton.BringToFront();
        }

        private void Log(string message)
        {
            _logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + "\r\n");
            try
            {
                _logBox.SelectionStart = _logBox.TextLength;
                _logBox.ScrollToCaret();
            }
            catch { }
        }

        private void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, 0x00A1, new IntPtr(2), IntPtr.Zero);
        }

        private float _appliedScale = 1f;
        private float _appliedDpi = 96f;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyScale(TargetScale());
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            if (IsHandleCreated) ApplyScale(TargetScale());
        }

        private float TargetScale()
        {
            float scale = DeviceDpi / 96f;
            string forced = Environment.GetEnvironmentVariable("MHUB_UI_SCALE");
            float parsed;
            if (!string.IsNullOrEmpty(forced) &&
                float.TryParse(forced, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed > 0.4f && parsed < 4f)
                scale = parsed;
            Rectangle work = Screen.FromHandle(Handle).WorkingArea;
            float fit = Math.Min(work.Width * 0.92f / 960f, work.Height * 0.92f / 676f);
            return Math.Max(0.6f, Math.Min(scale, fit));
        }

        private void ApplyScale(float scale)
        {
            if (Math.Abs(scale - _appliedScale) < 0.001f) return;
            float ratio = scale / _appliedScale;
            float fontRatio = (scale / DeviceDpi) / (_appliedScale / _appliedDpi);
            ClientSize = new Size((int)Math.Round(ClientSize.Width * ratio),
                (int)Math.Round(ClientSize.Height * ratio));
            ScaleTree(this, ratio, fontRatio);
            _appliedScale = scale;
            _appliedDpi = DeviceDpi;
        }

        private void ScaleTree(Control parent, float ratio, float fontRatio)
        {
            foreach (Control child in parent.Controls)
            {
                child.SetBounds((int)Math.Round(child.Left * ratio), (int)Math.Round(child.Top * ratio),
                    (int)Math.Round(child.Width * ratio), (int)Math.Round(child.Height * ratio));
                if (Math.Abs(fontRatio - 1f) > 0.001f)
                    child.Font = new Font(child.Font.FontFamily,
                        Math.Max(5f, child.Font.SizeInPoints * fontRatio), child.Font.Style, GraphicsUnit.Point);
                if (child is LightSurface)
                {
                    LightSurface surface = (LightSurface)child;
                    surface.Radius = (int)Math.Round(surface.Radius * ratio);
                }
                ScaleTree(child, ratio, fontRatio);
            }
        }

        private void EnableWindowEffects()
        {
            try
            {
                int preference = 2;
                DwmSetWindowAttribute(Handle, 33, ref preference, Marshal.SizeOf(typeof(int)));
            }
            catch { }
            Region = Draw.RoundRegion(new Rectangle(Point.Empty, ClientSize), 28);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Rectangle bounds = ClientRectangle;
            using (LinearGradientBrush backdrop = new LinearGradientBrush(bounds,
                Color.FromArgb(250, 251, 253), Color.FromArgb(219, 226, 235), 90f))
                g.FillRectangle(backdrop, bounds);

            g.SmoothingMode = SmoothingMode.AntiAlias;

            using (GraphicsPath glow = new GraphicsPath())
            {
                glow.AddEllipse(-220, -180, 780, 640);
                using (PathGradientBrush brush = new PathGradientBrush(glow))
                {
                    brush.CenterColor = Color.FromArgb(210, 255, 255, 255);
                    brush.SurroundColors = new Color[] { Color.FromArgb(0, 255, 255, 255) };
                    g.FillPath(brush, glow);
                }
            }
            using (GraphicsPath glow = new GraphicsPath())
            {
                glow.AddEllipse(Width - 420, Height - 380, 720, 620);
                using (PathGradientBrush brush = new PathGradientBrush(glow))
                {
                    brush.CenterColor = Color.FromArgb(150, 226, 236, 250);
                    brush.SurroundColors = new Color[] { Color.FromArgb(0, 226, 236, 250) };
                    g.FillPath(brush, glow);
                }
            }

            DrawGlassBand(g, -120, 60, 1250, 420, -18f, 120);
            DrawGlassBand(g, 120, 380, 1150, 380, -12f, 80);
        }

        private void DrawGlassBand(Graphics g, int x, int y, int width, int height, float angle, int alpha)
        {
            GraphicsState state = g.Save();
            try
            {
                g.TranslateTransform(x + width / 2f, y + height / 2f);
                g.RotateTransform(angle);
                Rectangle band = new Rectangle(-width / 2, -height / 2, width, height);
                using (GraphicsPath path = Draw.Round(band, height / 2))
                {
                    using (LinearGradientBrush fill = new LinearGradientBrush(band,
                        Color.FromArgb(alpha, 255, 255, 255), Color.FromArgb(alpha / 6, 255, 255, 255), 25f))
                        g.FillPath(fill, path);
                    using (Pen edge = new Pen(Color.FromArgb(Math.Min(255, alpha + 20), 255, 255, 255), 1.2f))
                        g.DrawPath(edge, path);
                }
            }
            finally { g.Restore(state); }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (IsHandleCreated && Width > 1 && Height > 1)
                Region = Draw.RoundRegion(new Rectangle(Point.Empty, ClientSize), 28);
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);
    }
}
